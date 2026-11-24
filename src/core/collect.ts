import { readFile } from "node:fs/promises";
import { type UseR2Client } from "../r2";
import { ParserUtils } from "../utils";
import { err, ok, Result } from "neverthrow";

export const collectReports = async (
  client: UseR2Client,
  reportPath: string,
): Promise<Result<string, string>> => {
  const contents = await readFile(reportPath, "utf8");
  const result = ParserUtils.hotpathReport(contents);

  return result.match(
    async (report) => {
      const benchmark = report.meta.criterion.benchmark;

      const key = await client.uploadTemporaryReport(
        benchmark,
        JSON.stringify(report),
      );

      return ok(`Collected Hotpath report for ${benchmark} at ${key}`);
    },
    (error) => err(error),
  );
};
