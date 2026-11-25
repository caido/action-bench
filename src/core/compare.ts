import { err, ok, Result } from "neverthrow";
import { Config, HotpathReport, MetricName } from "../utils";

export type Change = {
  functionId: string;
  before: number;
  after: number;
  deltaPercent: number;
  exceedsThreshold: boolean;
};

export type Comparison = {
  timing: Change[];
  icount: Change[];
  allocations: Change[];
  newFunctions: string[];
  trackedFunctionCount: number;
};

function compareMetric(
  metric: MetricName,
  current: HotpathReport,
  baseline: HotpathReport,
  functionId: string,
  threshold: number,
): Result<Change, string> {
  const currentValues = current[metric];
  const baselineValues = baseline[metric];

  const before = baselineValues.get(functionId);
  const after = currentValues.get(functionId);

  if (before === undefined) {
    return err(`Function is missing from baseline ${metric} data: ${functionId}`);
  }

  if (after === undefined) {
    return err(`Configured function is missing from current ${metric} data: ${functionId}`);
  }

  const deltaPercent =
    before === 0 ? (after === 0 ? 0 : Number.POSITIVE_INFINITY) : ((after - before) / before) * 100;

  return ok({
    functionId,
    before,
    after,
    deltaPercent,
    exceedsThreshold: deltaPercent > threshold,
  });
}

const metrics: MetricName[] = ["timing", "allocations", "icount"];

const normalizeGroup = (group: string): string => group.replace(/\/+$/, "");

const isInGroup = (benchmarkId: string, group: string): boolean => {
  const normalizedGroup = normalizeGroup(group);

  return benchmarkId === normalizedGroup || benchmarkId.startsWith(`${normalizedGroup}/`);
};

const compare = (
  config: Config,
  currentReports: Map<string, HotpathReport>,
  baselineReports: Map<string, HotpathReport>,
): Result<Comparison, string> => {
  const result: Comparison = {
    timing: [],
    icount: [],
    allocations: [],
    newFunctions: [],
    trackedFunctionCount: 0,
  };

  const currentEntries = [...currentReports.entries()];

  for (const [group, functions] of Object.entries(config.benchmarks)) {
    const reportsInGroup = currentEntries.filter(([benchmarkId]) => isInGroup(benchmarkId, group));

    if (reportsInGroup.length === 0) {
      return err(`Configured benchmark group is missing from current report: ${group}`);
    }

    for (const functionId of Object.keys(functions)) {
      const found = reportsInGroup.some(([, report]) =>
        metrics.some((metric) => report[metric].has(functionId)),
      );

      if (!found) {
        return err(
          `Configured function is missing from current report in group ${group}: ${functionId}`,
        );
      }
    }
  }

  for (const [benchmarkId, current] of currentEntries) {
    const applicableGroups = Object.entries(config.benchmarks)
      .filter(([group]) => isInGroup(benchmarkId, group))
      .sort(([left], [right]) => normalizeGroup(left).length - normalizeGroup(right).length);

    if (applicableGroups.length === 0) continue;

    const functionIds = new Set(
      applicableGroups.flatMap(([, functions]) => Object.keys(functions)),
    );

    const baseline = baselineReports.get(benchmarkId);

    for (const functionId of functionIds) {
      const currentHasFunction = metrics.some((metric) => current[metric].has(functionId));

      if (!currentHasFunction) continue;

      const applicableRules = applicableGroups.filter(([, functions]) =>
        Object.prototype.hasOwnProperty.call(functions, functionId),
      );

      const thresholds = { ...config.maxRegressionPercent };

      for (const [, functions] of applicableRules) {
        Object.assign(thresholds, functions[functionId]);
      }

      const displayId = `${benchmarkId} :: ${functionId}`;
      result.trackedFunctionCount += 1;

      const baselineHasFunction =
        baseline !== undefined && metrics.some((metric) => baseline[metric].has(functionId));

      if (!baselineHasFunction) {
        result.newFunctions.push(displayId);
        continue;
      }

      for (const metric of metrics) {
        const threshold = thresholds[metric];

        if (threshold === undefined) continue;

        const comparison = compareMetric(metric, current, baseline, functionId, threshold);

        if (comparison.isErr()) {
          return err(`${benchmarkId}: ${comparison.error}`);
        }

        result[metric].push({
          ...comparison.value,
          functionId: displayId,
        });
      }
    }
  }

  return ok(result);
};

export const CompareUtils = {
  compare,
};
