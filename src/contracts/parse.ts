import type { Binding } from "./types.js";

const lineOf = (src: string, idx: number) => src.slice(0, idx).split("\n").length;

// callIndexer("tool", { ...literal... })  — object-literal arg → keys
const TS_LITERAL = /\bcallIndexer(?:Cache)?\s*\(\s*"([^"]+)"\s*,\s*\{([^}]*)\}/g;
// callIndexer("tool", identifier)         — non-literal arg → unrecognized
const TS_NONLITERAL = /\bcallIndexer(?:Cache)?\s*\(\s*"([^"]+)"\s*,\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
const TS_KEY = /(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:/g;

export function parseTsConsumers(src: string, file: string): { bindings: Binding[]; unrecognized: number } {
  const bindings: Binding[] = [];
  let unrecognized = 0;
  const litSpans: Array<[number, number]> = [];
  for (const m of src.matchAll(TS_LITERAL)) {
    const tool = m[1]!, body = m[2]!;
    litSpans.push([m.index!, m.index! + m[0].length]);
    const keys: string[] = [];
    for (const km of body.matchAll(TS_KEY)) keys.push(km[1]!);
    // Consumer-side symbol is the file: callIndexer sites have no cheap
    // enclosing-function name, and enclosing-symbol resolution is deferred.
    bindings.push({ tool, role: "consumes", keys, file, symbol: file, line: lineOf(src, m.index!) });
  }
  for (const m of src.matchAll(TS_NONLITERAL)) {
    // skip if this match overlaps a literal match already counted
    if (litSpans.some(([s, e]) => m.index! >= s && m.index! < e)) continue;
    unrecognized++;
  }
  return { bindings, unrecognized };
}
