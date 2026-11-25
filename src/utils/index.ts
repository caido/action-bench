export * from "./parse";
export * from "./report";

export const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
