import { err, ok, Result } from "neverthrow";

export * from "./parse";
export * from "./report";

export const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const safeRequireEnv = (name: string): Result<string, string> => {
  const value = process.env[name];
  if (!value) return err(`Missing environment variable ${name}`);
  return ok(value);
};
