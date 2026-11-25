import { err, ok, Result } from "neverthrow";
import { z } from "zod";
import { parse } from "yaml";
import { MergedReport } from "./report";

const FunctionMetricSchema = z.object({
  name: z.string(),
  avg: z.string(),
});

const FunctionMetricsSchema = z.object({
  data: z.array(FunctionMetricSchema),
});

export const HotpathReportSchema = z.object({
  type: z.string(),
  meta: z.object({
    criterion: z.object({
      benchmark: z.string(),
    }),
  }),
  functions_timing: FunctionMetricsSchema,
  functions_alloc: FunctionMetricsSchema,
  functions_icount: FunctionMetricsSchema,
});

const HotpathReportsSchema = z.object({
  reports: z.array(HotpathReportSchema),
});

export type RawHotpathReport = z.infer<typeof HotpathReportSchema>;
export type RawHotpathReports = z.infer<typeof HotpathReportsSchema>;

const hotpathReport = (content: string): Result<RawHotpathReport, string> => {
  const value: unknown = JSON.parse(content);
  const result = HotpathReportSchema.safeParse(value);

  if (!result.success) return err(result.error.message);

  return ok(result.data);
};

const Percentages = z.object({
  timing: z.number().min(0),
  allocations: z.number().min(0),
  icount: z.number().min(0),
});

const ThresholdOverrides = Percentages.partial();

const BaseThresholds = ThresholdOverrides.refine(
  (thresholds) => Object.keys(thresholds).length > 0,
  "At least one global regression threshold is required",
);

const ConfigSchema = z.object({
  referenceBranch: z.string().min(1),
  retention: z.number().int().min(1).default(5),
  maxRegressionPercent: BaseThresholds,
  benchmarks: z.record(z.string().min(1), z.record(z.string().min(1), ThresholdOverrides)),
});

export type Config = z.infer<typeof ConfigSchema>;
export type MetricName = "timing" | "allocations" | "icount";

export const config = (content: string): Result<Config, string> => {
  const value = parse(content);
  const result = ConfigSchema.safeParse(value);

  if (!result.success) return err(result.error.message);

  return ok(result.data);
};

export type HotpathReport = {
  benchmark: string;
  timing: Map<string, number>;
  allocations: Map<string, number>;
  icount: Map<string, number>;
};

const parseAverage = (metric: MetricName, value: string): Result<number, string> => {
  if (metric === "icount") {
    const result = parseFloat(value);

    return Number.isNaN(result) ? err(`icount value is not a number: ${value}`) : ok(result);
  }

  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*([^\s]*)$/);
  if (!match) return err(`Unrecognized Hotpath ${metric} average: ${value}`);

  const amount = Number(match[1]);
  const unit = match[2].replace("μ", "µ");

  const factors: Record<string, number> =
    metric === "timing"
      ? { ns: 1e-6, µs: 1e-3, us: 1e-3, ms: 1, s: 1000 }
      : {
          B: 1,
          KB: 1_000,
          KiB: 1_024,
          MB: 1_000_000,
          MiB: 1_048_576,
          GB: 1_000_000_000,
          GiB: 1_073_741_824,
        };

  const factor = factors[unit];

  return factor === undefined
    ? err(`Unsupported Hotpath ${metric} unit: ${unit}`)
    : ok(amount * factor);
};

const parseAverages = (
  metric: MetricName,
  data: RawHotpathReport["functions_timing"]["data"],
): Result<Map<string, number>, string> => {
  const entries: [string, number][] = [];

  for (const { name, avg } of data) {
    const parsed = parseAverage(metric, avg);
    if (parsed.isErr()) return err(parsed.error);

    entries.push([name, parsed.value]);
  }

  return ok(new Map(entries));
};

const flatReports = (mergedReport: MergedReport): Result<Map<string, HotpathReport>, string> => {
  const reports = new Map<string, HotpathReport>();

  for (const report of mergedReport.reports) {
    const benchmark = report.meta.criterion.benchmark;

    const timing = parseAverages("timing", report.functions_timing.data);
    if (timing.isErr()) {
      return err(`Failed to parse timing for ${benchmark}: ${timing.error}`);
    }

    const allocations = parseAverages("allocations", report.functions_alloc.data);
    if (allocations.isErr()) {
      return err(`Failed to parse allocations for ${benchmark}: ${allocations.error}`);
    }

    const icount = parseAverages("icount", report.functions_icount.data);
    if (icount.isErr()) {
      return err(`Failed to parse icount for ${benchmark}: ${icount.error}`);
    }

    reports.set(benchmark, {
      benchmark,
      timing: timing.value,
      allocations: allocations.value,
      icount: icount.value,
    });
  }

  return ok(reports);
};

export const ParserUtils = {
  hotpathReport,
  flatReports,
  config,
};
