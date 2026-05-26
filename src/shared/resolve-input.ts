import { GraphStore } from "../graph/store.js";

export type ResolvedSymbol = { qn: string; file_path: string; kind: string };

export type ResolveResult =
  | { kind: "single"; symbol: ResolvedSymbol }
  | { kind: "multi"; candidates: ResolvedSymbol[]; input: string }
  | { kind: "none"; input: string };

const SOURCE_EXTS = new RegExp("\\.(vue|tsx?|jsx?|py|go|rs|java|cs|cpp|c|h|rb|php|swift|kt)$");
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function splitFileSymbol(input: string): { filePath: string; symbol: string } | null {
  // editor-jump style: `path/to/file.ext:identifier`
  const colonIdx = input.lastIndexOf(":");
  if (colonIdx <= 0 || colonIdx >= input.length - 1) return null;
  const filePath = input.slice(0, colonIdx);
  const symbol = input.slice(colonIdx + 1);
  if (!SOURCE_EXTS.test(filePath)) return null;
  if (!IDENTIFIER.test(symbol)) return null;
  return { filePath, symbol };
}

function lookupByFilePath(store: GraphStore, input: string): ResolvedSymbol[] {
  return store.queryRaw<ResolvedSymbol>(
    "SELECT qualified_name AS qn, file_path, kind FROM nodes WHERE file_path = ? OR file_path LIKE ('%' || ?) LIMIT 5",
    [input, input],
  );
}

function lookupByFileAndName(
  store: GraphStore,
  filePath: string,
  symbol: string,
): ResolvedSymbol[] {
  return store.queryRaw<ResolvedSymbol>(
    "SELECT qualified_name AS qn, file_path, kind FROM nodes WHERE (file_path = ? OR file_path LIKE ('%' || ?)) AND name = ? LIMIT 5",
    [filePath, filePath, symbol],
  );
}

function lookupByQn(store: GraphStore, qn: string): ResolvedSymbol[] {
  return store.queryRaw<ResolvedSymbol>(
    "SELECT qualified_name AS qn, file_path, kind FROM nodes WHERE qualified_name = ? LIMIT 5",
    [qn],
  );
}

function lookupByName(store: GraphStore, name: string): ResolvedSymbol[] {
  return store.queryRaw<ResolvedSymbol>(
    "SELECT qualified_name AS qn, file_path, kind FROM nodes WHERE name = ? OR name LIKE ? LIMIT 5",
    [name, `%${name}%`],
  );
}

export function resolveInput(input: string, project: string, dbPath: string): ResolveResult {
  const store = new GraphStore(dbPath);

  let candidates: ResolvedSymbol[] = [];

  // 0. file:symbol form (editor-jump style, e.g. apps/foo/bar.ts:Baz)
  const split = splitFileSymbol(input);
  if (split) {
    candidates = lookupByFileAndName(store, split.filePath, split.symbol);
  }

  // 1. File path (contains '/' or ends in a source extension)
  if (candidates.length === 0 && (input.includes("/") || SOURCE_EXTS.test(input))) {
    candidates = lookupByFilePath(store, input);
  }

  // 2. Canonical qn (starts with project prefix)
  if (candidates.length === 0 && input.startsWith(`${project}.`)) {
    candidates = lookupByQn(store, input);
  }

  // 3. Dotted suffix (e.g. components.foo)
  if (candidates.length === 0 && input.includes(".") && !input.includes("/")) {
    candidates = lookupByQn(store, input);
    if (candidates.length === 0) {
      candidates = store.queryRaw<ResolvedSymbol>(
        "SELECT qualified_name AS qn, file_path, kind FROM nodes WHERE qualified_name LIKE ('%' || ?) LIMIT 5",
        [input],
      );
    }
  }

  // 4. Bare name fallback
  if (candidates.length === 0) {
    candidates = lookupByName(store, input);
  }

  if (candidates.length === 0) return { kind: "none", input };
  if (candidates.length === 1) return { kind: "single", symbol: candidates[0] };
  return { kind: "multi", candidates, input };
}
