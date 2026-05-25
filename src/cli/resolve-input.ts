import { resolveInput as sharedResolve, type ResolvedSymbol } from "../shared/resolve-input.js";
import { DomainError } from "./errors.js";

export type { ResolvedSymbol } from "../shared/resolve-input.js";
export type Disambiguation = { candidates: ResolvedSymbol[]; input: string };

const SOURCE_EXTS = new RegExp("\\.(vue|tsx?|jsx?|py|go|rs|java|cs|cpp|c|h|rb|php|swift|kt)$");

function tipFor(input: string): string {
  if (input.includes("/") || SOURCE_EXTS.test(input)) {
    return `Try:\n  cortex code find ${input.split("/").pop()?.replace(SOURCE_EXTS, "")}    search by name\n  cortex index changes                refresh the index`;
  }
  return `Try:\n  cortex code find '${input}%'    name prefix match\n  cortex help qualified-names    learn the canonical form`;
}

export function resolveInput(
  input: string,
  project: string,
  dbPath: string,
): ResolvedSymbol | Disambiguation {
  const r = sharedResolve(input, project, dbPath);
  if (r.kind === "none") {
    throw new DomainError(`no symbol matched '${input}'`, tipFor(input));
  }
  if (r.kind === "single") return r.symbol;
  return { candidates: r.candidates, input: r.input };
}
