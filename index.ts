import { Octokit } from "octokit";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import YAML from "yaml";
import { stringify as csvStringify } from "csv-stringify/sync";
import fs from "fs";
import { cleanEnv, str } from "envalid";

const env = cleanEnv(process.env, {
  GITHUB_USERNAME: str({ default: undefined }),
  GITHUB_ORG: str({ default: undefined }),
  GITHUB_TOKEN: str(),
});

const owner = env.GITHUB_USERNAME ?? env.GITHUB_ORG;
if (!owner) {
  throw new Error("GITHUB_USERNAME or GITHUB_ORG is required");
}

const MyOctokit = Octokit.plugin(paginateRest);
const octokit = new MyOctokit({ auth: env.GITHUB_TOKEN });

const fetchRepositories = async (owner: string) => {
  console.info(`Fetching repositories for ${owner}...`);

  const repos = await (() => {
    if (env.GITHUB_ORG) {
      return octokit.paginate("GET /orgs/{org}/repos", {
        org: owner,
      });
    }
    return octokit.paginate("GET /users/{username}/repos", {
      username: owner,
    });
  })();
  const filteredRepos = repos.filter((repo) => {
    if (repo.archived) return false;
    if (repo.fork) return false;
    return true;
  });

  console.info(`Fetched ${filteredRepos.length} repositories`);
  return filteredRepos;
};

const fetchWorkflows = async (options: {
  owner: string;
  repo: string;
}): Promise<{ path: string }[]> => {
  console.info(`Fetching workflows for ${options.owner}/${options.repo}...`);

  const workflowFiles = await fetchFiles({
    owner: options.owner,
    repo: options.repo,
    path: ".github/workflows",
  });

  const filteredFiles = workflowFiles.filter((file) => {
    return file.path.endsWith(".yml") || file.path.endsWith(".yaml");
  });

  console.info(`Fetched ${filteredFiles.length} workflows`);
  return filteredFiles;
};

const extractUsesFromWorkflow = (workflowYamlRaw: string) => {
  const workflowYaml = YAML.parse(workflowYamlRaw);
  return Object.values(workflowYaml.jobs)
    .filter((job: any) => job.steps)
    .flatMap((job: any) => Object.values(job.steps))
    .filter((step: any) => step.uses)
    .map((step: any) => step.uses)
    .filter((uses: string) => !uses.startsWith("."));
};

const fetchActionYmlRaw = async (uses: string) => {
  const [action, ref] = uses.split("@");
  const [owner, repo, ...paths] = action.split("/");

  const actionYmlRaw = await fetchFileContent({
    owner,
    repo,
    path: [...paths, "action.yml"].join("/"),
    ref,
  }).catch((error) => {
    if (error.status && error.status === 404) {
      return fetchFileContent({
        owner,
        repo,
        path: [...paths, "action.yaml"].join("/"),
        ref,
      }).catch((error) => {
        if (error.status && error.status === 404) {
          return null;
        }
        throw error;
      });
    }
    throw error;
  });

  return actionYmlRaw;
};

const fetchFiles = async (options: {
  owner: string;
  repo: string;
  path: string;
}): Promise<{ path: string }[]> => {
  return octokit
    .paginate("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: options.owner,
      repo: options.repo,
      path: options.path,
    })
    .catch((error) => {
      if (error.status && error.status === 404) {
        return [];
      }
      throw error;
    }) as Promise<{ path: string }[]>;
};

const fetchFileContent = async (options: {
  owner: string;
  repo: string;
  path: string;
  ref?: string;
}) => {
  console.info(
    `Fetching file content for ${options.owner}/${options.repo}/${options.path}...`
  );

  const response = await octokit.request(
    "GET /repos/{owner}/{repo}/contents/{path}",
    {
      owner: options.owner,
      repo: options.repo,
      path: options.path,
      ref: options.ref,
    }
  );
  const data = response.data as any;
  if (data.type !== "file") {
    throw new Error(`Not a file: ${options.path}`);
  }

  console.info("Fetched file content");
  return Buffer.from(data.content, "base64").toString();
};

const actionCache: Record<string, any> = {};

const repositories = await fetchRepositories(owner);
for (const repository of repositories) {
  const rows: string[][] = [["workflow", "action", "using"]];

  const workflows = await fetchWorkflows({
    owner: repository.owner.login,
    repo: repository.name,
  });

  for (const workflow of workflows) {
    const usesCache: Record<string, boolean> = {};

    const workflowYamlRaw = await fetchFileContent({
      owner: repository.owner.login,
      repo: repository.name,
      path: workflow.path,
    });
    const usesList = extractUsesFromWorkflow(workflowYamlRaw);

    for (const uses of usesList) {
      if (usesCache[uses]) {
        continue;
      }
      usesCache[uses] = true;

      let actionYml = actionCache[uses];
      if (!actionYml) {
        const actionYmlRaw = await fetchActionYmlRaw(uses);
        if (actionYmlRaw) {
          actionYml = YAML.parse(actionYmlRaw);
        } else {
          actionYml = { runs: { using: "NOT_FOUND" } };
        }
      }

      actionCache[uses] = actionYml;
      rows.push([workflow.path, uses, actionYml.runs.using]);
    }
  }

  fs.mkdirSync(`./outputs/${owner}`, { recursive: true });
  fs.writeFileSync(
    `./outputs/${owner}/${repository.name}.csv`,
    csvStringify(rows)
  );
  console.info(`Saved ${repository.name}.csv`);
}
