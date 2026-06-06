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

const C_HANDLER = /\bstatic\s+char\s*\*\s*handle_([a-z0-9_]+)\s*\(/g;
const C_ARG = /ctx_mcp_get_(?:string|int|bool)_arg\s*\(\s*args\s*,\s*"([^"]+)"\s*[,)]/g;

export function parseCProviders(src: string, file: string): { bindings: Binding[]; unrecognized: number } {
  const heads = [...src.matchAll(C_HANDLER)];
  const bindings: Binding[] = [];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]!;
    const start = h.index!;
    const end = i + 1 < heads.length ? heads[i + 1]!.index! : src.length;
    const body = src.slice(start, end);
    const keys: string[] = [];
    for (const am of body.matchAll(C_ARG)) if (!keys.includes(am[1]!)) keys.push(am[1]!);
    bindings.push({ tool: h[1]!, role: "provides", keys, file, symbol: `handle_${h[1]}`, line: lineOf(src, start) });
  }
  return { bindings, unrecognized: 0 };
}
