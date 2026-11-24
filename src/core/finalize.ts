import { err, ok, Result, ResultAsync } from "neverthrow";
import { UseR2Client } from "../r2";
import {
  Config,
  MergedReport,
  MergeUtils,
  ParserUtils,
  toErrorMessage,
} from "../utils";
import { Context } from "@actions/github/lib/context";
import { updatePullRequestComment } from "./comment";
import { CompareUtils } from "./compare";

export const finalizeRun = async (
  client: UseR2Client,
  context: Context,
  token: string,
  config: Config,
): Promise<Result<string, string>> => {
  const temporaryKeys = await client.listTemporaryObject();
  if (temporaryKeys.length === 0)
    return err(
      `No reports were collected for this run (${client.temporaryPrefix})`,
    );

  const reportResults = await Promise.all(
    temporaryKeys.map((key) =>
      ResultAsync.fromPromise(client.readObject(key), toErrorMessage)
        .andThen((result) => result)
        .andThen((content) => ParserUtils.hotpathReport(content)),
    ),
  );

  const firstError = reportResults.find((result) => result.isErr());

  if (firstError?.isErr()) return err(firstError.error);

  const rawReports = reportResults.flatMap((result) =>
    result.isOk() ? [result.value] : [],
  );

  const mergedJson = MergeUtils.reports(rawReports);

  if (mergedJson.isErr()) return err(mergedJson.error);

  const currentReports = ParserUtils.flatReports(mergedJson.value);

  if (currentReports.isErr()) return err(currentReports.error);

  const currentBenchmarkIds = [...currentReports.value.keys()];

  const missingBenchmarkGroups = Object.keys(config.benchmarks).filter(
    (group) =>
      !currentBenchmarkIds.some(
        (id) => id === group || id.startsWith(`${group}/`),
      ),
  );

  if (missingBenchmarkGroups.length > 0) {
    return err(
      `Missing configured benchmark group(s): ${missingBenchmarkGroups.join(", ")}`,
    );
  }
  const eventName = context.eventName;

  if (eventName === "push")
    return onPush(client, context, config, temporaryKeys, mergedJson.value);

  if (eventName !== "pull_request")
    return onOtherEvent(client, eventName, temporaryKeys);

  const baseline = await client.latestBaseline();

  if (baseline === undefined) {
    await client.deleteTemporaryObjects(temporaryKeys);
    return ok(
      `No baseline exists for ${config.referenceBranch}; comparison skipped`,
    );
  }

  const baselineContent = await client.readObject(baseline.key);
  if (baselineContent.isErr()) return err(baselineContent.error);

  const baselineMerged = MergeUtils.fromText(baselineContent.value);
  if (baselineMerged.isErr()) return err(baselineMerged.error);

  const baselineReports = ParserUtils.flatReports(baselineMerged.value);
  if (baselineReports.isErr()) return err(baselineReports.error);

  const comparison = CompareUtils.compare(
    config,
    currentReports.value,
    baselineReports.value,
  );

  if (comparison.isErr()) return err(comparison.error);

  const hasRegressionDetected = [
    ...comparison.value.timing,
    ...comparison.value.allocations,
    ...comparison.value.icount,
  ].some((change) => change.exceedsThreshold);

  const comment = await updatePullRequestComment(
    token,
    comparison.value,
    hasRegressionDetected,
  );
  if (comment.isErr()) return err(comment.error);

  await client.deleteTemporaryObjects(temporaryKeys);

  if (hasRegressionDetected) {
    return err(
      "One or more benchmark metrics exceeded their regression threshold",
    );
  }

  return ok("every benchmark respect is own threshold");
};

const onPush = async (
  client: UseR2Client,
  context: Context,
  config: Config,
  temporaryKeys: string[],
  mergedJson: MergedReport,
) => {
  const branch = context.ref.replace(/^refs\/heads\//, "");
  await client.deleteTemporaryObjects(temporaryKeys);

  if (branch !== config.referenceBranch) {
    return ok(`Not publishing baseline: ${branch} is not the reference branch`);
  }

  await client.uploadBaseline(JSON.stringify(mergedJson));
  await client.pruneBaselines(config.retention);
  return ok(`Published baseline ${client.baselineKey}`);
};

const onOtherEvent = async (
  client: UseR2Client,
  eventName: string,
  temporaryKeys: string[],
) => {
  await client.deleteTemporaryObjects(temporaryKeys);
  return ok(`Ignoring event ${eventName}`);
};
