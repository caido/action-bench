import * as github from "@actions/github";

const MARKER = "<!-- action-bench-report -->";

import type { Change, Comparison } from "./compare";
import { err, ok, Result } from "neverthrow";

type Metric = "timing" | "allocations" | "icount";

function formatValue(metric: Metric, value: number): string {
  switch (metric) {
    case "allocations": {
      return `${value.toFixed(0)} B`;
    }
    case "timing": {
      return `${value.toFixed(3)} ms`;
    }
    case "icount": {
      return `${value.toFixed(2)}`;
    }
  }
}

function table(metric: Metric, changes: Change[]): string {
  if (changes.length === 0) return "_No functions changed._";

  const rows = changes
    .map((change) => {
      const delta = `${change.deltaPercent > 0 ? "+" : ""}${change.deltaPercent.toFixed(2)}%`;
      const status = change.exceedsThreshold ? " ⚠️" : "";
      return `| \`${change.functionId}\` | ${formatValue(metric, change.before)} | ${formatValue(metric, change.after)} | ${delta}${status} |`;
    })
    .join("\n");

  return ["| Function | Before | After | Difference |", "|---|---:|---:|---:|", rows].join("\n");
}

export const updatePullRequestComment = async (
  token: string,
  comparison: Comparison,
  hasRegression: boolean,
): Promise<Result<string, string>> => {
  const pullRequest = github.context.payload.pull_request;
  if (!pullRequest) return err("not a pull request");

  const { owner, repo } = github.context.repo;
  const octokit = github.getOctokit(token);
  const issueNumber = pullRequest.number;

  const changedCount = comparison.timing.length + comparison.allocations.length;
  const summary =
    comparison.newFunctions.length > 0
      ? `New functions without a comparison: ${comparison.newFunctions.map((id) => `\`${id}\``).join(", ")}.`
      : changedCount === 0
        ? `All good for the ${comparison.trackedFunctionCount} tracked functions.`
        : hasRegression
          ? "Some metrics exceed their regression thresholds."
          : "No metrics exceed their regression thresholds.";

  const body = [
    MARKER,
    `## ${hasRegression ? "❌" : "✅"} action-bench`,
    summary,
    "<details>",
    "<summary>Show differences</summary>",
    "",
    "### Timing",
    table("timing", comparison.timing),
    "",
    "### Allocations",
    table("allocations", comparison.allocations),
    "",
    "### Icount",
    table("icount", comparison.icount),
    "</details>",
  ].join("\n");

  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });

  let existing;

  for (const comment of comments) {
    if (comment.body?.includes(MARKER)) {
      existing = comment;
      break;
    }
  }

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
  }

  return ok("Updated action-bench pull request comment");
};
