import { err, ok, Result } from "neverthrow";
import { HotpathReportSchema, RawHotpathReport } from "./parse";
import z from "zod";

const MergedReportSchema = z.object({
  type: z.literal("hotpath_merged_report"),
  schema_version: z.literal(1),
  reports: z.array(HotpathReportSchema),
});

export type MergedReport = z.infer<typeof MergedReportSchema>;

const reports = (reports: RawHotpathReport[]): Result<MergedReport, string> => {
  if (reports.length === 0) return err("No Hotpath benchmark reports were collected");

  const ordered = reports
    .map((report) => ({ id: report.meta.criterion.benchmark, report }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const seen = new Set<string>();

  for (const { id } of ordered) {
    if (seen.has(id)) return err(`Duplicate Hotpath benchmark report: ${id}`);
    seen.add(id);
  }

  return ok({
    type: "hotpath_merged_report",
    schema_version: 1,
    reports: ordered.map(({ report }) => report),
  });
};

const fromText = (content: string): Result<MergedReport, string> => {
  const value: unknown = JSON.parse(content);
  const result = MergedReportSchema.safeParse(value);

  if (!result.success) return err(result.error.message);

  return ok(result.data);
};

export const MergeUtils = {
  reports,
  fromText,
};
