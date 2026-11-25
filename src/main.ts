import * as core from "@actions/core";
import * as github from "@actions/github";
import { err, Result, ResultAsync } from "neverthrow";
import { collectReports, finalizeRun, Mode, ModeUtil } from "./core";
import { useR2Client } from "./r2";
import { ParserUtils, toErrorMessage } from "./utils";
import { readFile } from "node:fs/promises";

type RunResult = Result<string, string>;

const run = async (): Promise<RunResult> => {
  const mode = ModeUtil.fromString(core.getInput("mode", { required: true }));

  if (mode.isErr()) return err(mode.error);

  const bucket = core.getInput("bucket", { required: true });
  const configPath = core.getInput("config", { required: true });
  const token = core.getInput("github-token");

  const { owner, repo } = github.context.repo;
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";

  const runId = process.env.GITHUB_RUN_ID;

  if (runId === undefined) return err("GITHUB_RUN_ID is required");

  const content = await readFile(configPath, "utf8");
  const config = ParserUtils.config(content);

  if (config.isErr()) return err(config.error);

  const client = useR2Client({
    bucket,
    owner,
    repo,
    runId,
    attempt,
    branch: config.value.referenceBranch,
    sha: github.context.sha,
  });

  let result;

  switch (mode.value) {
    case Mode.COLLECT: {
      result = await collectReports(client, core.getInput("report", { required: true }));
      break;
    }
    case Mode.FINALIZE: {
      if (github.context.eventName === "pull_request" && !token) {
        return err("github-token is required when finalizing a pull request");
      }

      result = await finalizeRun(client, github.context, token, config.value);
      break;
    }
  }

  if (result.isErr()) {
    const temporaryKeys = await client.listTemporaryObject();
    await client.deleteTemporaryObjects(temporaryKeys);
  }

  return result;
};

void ResultAsync.fromPromise(run(), toErrorMessage)
  .andThen((result) => result)
  .match(
    (message) => core.info(message),
    (message) => core.setFailed(message),
  );
