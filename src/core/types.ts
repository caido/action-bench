import { err, ok } from "neverthrow";

export enum Mode {
  COLLECT = "collect",
  FINALIZE = "finalize",
}

const fromString = (mode: string) => {
  if (mode === "collect") return ok(Mode.COLLECT);
  if (mode === "finalize") return ok(Mode.FINALIZE);
  return err(`Unsupported mode ${mode}; use collect or finalize`);
};

export const ModeUtil = {
  fromString,
};
