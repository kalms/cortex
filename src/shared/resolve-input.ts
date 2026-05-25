import { GraphStore } from "../graph/store.js";

export type ResolvedSymbol = { qn: string; file_path: string; kind: string };

export type ResolveResult =
  | { kind: "single"; symbol: ResolvedSymbol }
  | { kind: "multi"; candidates: ResolvedSymbol[]; input: string }
  | { kind: "none"; input: string };

const SOURCE_EXTS = new RegExp("\\.(vue|tsx?|jsx?|py|go|rs|java|cs|cpp|c|h|rb|php|swift|kt)$");

function lookupByFilePath(store: GraphStore, input: string): ResolvedSymbol[] {
  return store.queryRaw<ResolvedSymbol>(
    "SELECT qualified_name AS qn, file_path, kind FROM nodes WHERE file_path = ? OR file_path LIKE ('%' || ?) LIMIT 5",
    [input, input],
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

  // 1. File path (contains '/' or ends in a source extension)
  if (input.includes("/") || SOURCE_EXTS.test(input)) {
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
