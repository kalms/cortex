// src/frame-extraction/frame-kind.ts
/**
 * Deterministic 6-layer frame classifier (taxonomy milestone 1: classify+observe).
 *
 * Agreement-based combination (NOT the original spec's first-match-wins chain):
 * every source always runs and emits weight contributions over the six layers;
 * contributions sum; argmax wins; ties break by canonical LAYER_ORDER; a summed
 * max below MIN_SIGNAL falls back to 'domain'. Rationale: measurement on the
 * cortex graph showed topology is authoritative at the surface↔substrate ENDS
 * of the layer axis and silent in the middle, while lexical signals refine the
 * middle — so sources must combine, not chain. The original chain's #1 source
 * (ACDC dominator symbol) is unbuildable: the shipped tfidf+hdbscan pipeline
 * produces no dominator data. is_entry_point is deliberately unused (measured
 * too loose: 72 "entry points" in frame-extraction alone).
 *
 * Determinism contract (spec, non-negotiable): no randomness, no timestamps,
 * named constants, stable sorts, canonical tie-break. Internal machinery
 * (confidence, contributions) exists for the eval harness ONLY — the public
 * `classifyFrames` strips it; frame-map reads the internal shape (for `fallback`)
 * but never serializes those fields.
 *
 * Design: docs/architecture/frame-extraction.md ("Layer taxonomy").
 * PURE — no I/O.
 */

export type FrameLayer =
  | "interface"
  | "orchestration"
  | "domain"
  | "data"
  | "infrastructure"
  | "ceremony";

/** Canonical order — fixed tie-break, also the legend order. */
export const LAYER_ORDER: readonly FrameLayer[] = [
  "interface",
  "orchestration",
  "domain",
  "data",
  "infrastructure",
  "ceremony",
];

/** Per-layer ranking multiplier (frame-ranking.md taxonomy table). Used by the
 *  enable slice (kind-weight) to tilt the ambient set toward narrative layers. */
export const KIND_WEIGHT: Record<FrameLayer, number> = {
  interface: 0.9,
  orchestration: 0.85,
  domain: 1.0,
  data: 0.75,
  infrastructure: 0.55,
  ceremony: 0.2,
};

/** Kind-weight for a classified frame. Fallback-domain is demoted to 0.5: a
 *  frame that earned nothing (D-8vbv) must not carry domain's top weight —
 *  the D-qn7z trap. Total over the FrameLayer union. */
export function kindWeight(layer: FrameLayer, fallback: boolean): number {
  if (layer === "domain" && fallback) return 0.5;
  return KIND_WEIGHT[layer];
}

export interface FrameKindInput {
  frame_id: number;
  frame_label: string;
  member_paths: string[];
  /** Σ inbound inter-frame edge weight (frame-flow-rollup stats). */
  fanIn: number;
  /** Σ outbound inter-frame edge weight. */
  fanOut: number;
}

/** Public result — the ONLY shape that leaves the module for serialization. */
export interface FrameKind {
  frame_id: number;
  layer: FrameLayer;
}

/** Internal result — eval harness + tests only. Never serialize. */
export interface FrameKindInternal extends FrameKind {
  /** argmax margin over runner-up, 0–1; 0 for fallback AND for ties. */
  confidence: number;
  /** true = no signal cleared MIN_SIGNAL (layer is the domain fallback);
   *  false + confidence 0 = a within-pair tie (strong signal, unsplit pair).
   *  Observe-phase addition: conf=0.00 alone conflated the two states. */
  fallback: boolean;
  contributions: Record<FrameLayer, number>;
}

/* ── Constants (tuned during the observation phase; committed code) ── */
const SINK_SURFACE = 0.35;
const SINK_SUBSTRATE = 0.65;
const W_GRAPH = 1.0;
const W_PATH = 0.8;
const W_TEST = 0.9;
const W_CEREMONY_EXT = 0.5;
const W_LABEL = 0.4;
/** 0.4: a weak plurality must not override the domain fallback — measured on
 *  the cortex fixture, boundary-grazing topology alone (sink 0.33 → 0.34
 *  strength) wrongly claimed the `decisions` frame for 'interface'. */
const MIN_SIGNAL = 0.4;
/** 0.8, not 0.5: clustering co-locates tests with their subjects (the
 *  `decisions` frame is 65% tests yet is the product's subject). Only a
 *  near-all-tests frame is ceremony BY CONTENT. */
const TEST_FRACTION_MIN = 0.8;
const EXT_FRACTION_MIN = 0.5;
/** 0.5: domain as the earned-fallback residual in the otherwise-silent middle
 *  sink band. Override-protection is STRUCTURAL, not weight-based — the residual
 *  is applied only when no layer-specific source cleared MIN_SIGNAL (see the
 *  combine step), so any real signal wins regardless of this magnitude. 0.5
 *  sets the bar: 0.5 × 0.8 = MIN_SIGNAL, so a frame earns domain (vs defaulting
 *  to fallback-domain) at ~80% runtime content. Test-/tooling-heavy frames stay
 *  below threshold (fallback or ceremony). */
const W_DOMAIN_RUNTIME = 0.5;

/** Curated path-segment → layer table (frame-ranking.md §classification-sources,
 *  v1). No tokens map to 'domain': domain is what remains when a frame is
 *  neither surface plumbing, substrate plumbing, nor ceremony. Test-ness is
 *  deliberately NOT a path token: tests co-cluster with their subjects, so
 *  test-shadow paths are not an independent ceremony signal — Source C owns
 *  test detection behind TEST_FRACTION_MIN. */
const PATH_LAYER_TABLE: ReadonlyArray<[FrameLayer, ReadonlySet<string>]> = [
  ["interface", new Set(["routes", "pages", "views", "components", "cli", "ui"])],
  ["orchestration", new Set(["handlers", "controllers", "services", "workflows", "seed"])],
  ["data", new Set(["models", "schemas", "db", "store", "persistence", "events"])],
  ["infrastructure", new Set(["transport", "infra", "mcp-server", "server", "cache", "queue", "indexer"])],
  ["ceremony", new Set(["evals", "scripts", "build", "hooks", "config", "integration"])],
];

/** Source C's test detector. Matches .test./.spec. files and tests/ dirs;
 *  gated behind TEST_FRACTION_MIN so only near-all-tests frames qualify. */
const TEST_PATH_RE = /\.test\.|\.spec\.|(^|\/)tests?\//;
const NON_RUNTIME_EXT_RE = /\.(sh|ya?ml|json|md)$/;

/** Nitro/h3 method-suffixed route files (`server/api/*.{get,post,…}.ts`) are
 *  handlers — orchestration BY IDIOM. Observe-phase finding (private-monorepo,
 *  2026-06-13): these frames are pure sources (sink 0.0), the surface pair
 *  always tied, and canonical order starved orchestration to zero frames —
 *  no token in PATH_LAYER_TABLE matches the Nitro idiom.
 *  Scoped to route dirs: `<thing>.get.ts` is also a typed-accessor idiom
 *  outside `api/`/`routes/`, and unscoped it flipped data-substrate frames.
 *  Case-insensitive, matching pathSegments' lowercasing. */
const HANDLER_SUFFIX_RE = /\.(get|post|put|patch|delete|head|options)\.[cm]?[jt]sx?$/i;
const ROUTE_DIR_TOKENS: ReadonlySet<string> = new Set(["api", "routes"]);
/** Same weight as a path-token match — aliased, not restated, so tuning
 *  W_PATH keeps the documented equality. */
const W_HANDLER = W_PATH;

function isRouteHandler(path: string): boolean {
  return HANDLER_SUFFIX_RE.test(path) && pathSegments(path).some((seg) => ROUTE_DIR_TOKENS.has(seg));
}

/** Lowercased directory segments + basename sans extension. */
function pathSegments(path: string): string[] {
  const parts = path.toLowerCase().split("/");
  const base = parts.pop() ?? "";
  const dot = base.lastIndexOf(".");
  parts.push(dot > 0 ? base.slice(0, dot) : base);
  return parts;
}

function zeroContributions(): Record<FrameLayer, number> {
  return {
    interface: 0,
    orchestration: 0,
    domain: 0,
    data: 0,
    infrastructure: 0,
    ceremony: 0,
  };
}

function classifyOne(input: FrameKindInput): FrameKindInternal {
  const c = zeroContributions();
  const members = input.member_paths;

  // ── Source A: graph position (authoritative at the ends, silent in the middle)
  const total = input.fanIn + input.fanOut;
  const sink = total > 0 ? input.fanIn / total : 0.5;
  if (sink <= SINK_SURFACE) {
    const s = (0.5 - sink) * 2 * W_GRAPH;
    c.interface += s;
    c.orchestration += s;
  } else if (sink >= SINK_SUBSTRATE) {
    const s = (sink - 0.5) * 2 * W_GRAPH;
    c.data += s;
    c.infrastructure += s;
  }
  // Domain residual (middle band only): runtime code sitting topologically
  // between surface and substrate. Held aside, NOT summed into c here — domain
  // is the *earned fallback*, applied at combine time only if no layer-specific
  // source (B/C) cleared MIN_SIGNAL. This keeps a real signal (even a weak
  // W_LABEL one) from being overridden by the generic residual.
  let domainResidual = 0;
  if (sink > SINK_SURFACE && sink < SINK_SUBSTRATE && members.length > 0) {
    const runtimeFrac =
      members.filter((p) => !TEST_PATH_RE.test(p) && !NON_RUNTIME_EXT_RE.test(p)).length /
      members.length;
    domainResidual = W_DOMAIN_RUNTIME * runtimeFrac;
  }

  // ── Source B: path patterns (fraction of members matching each layer's tokens)
  if (members.length > 0) {
    for (const [layer, tokens] of PATH_LAYER_TABLE) {
      let matching = 0;
      for (const p of members) {
        if (pathSegments(p).some((seg) => tokens.has(seg))) matching++;
      }
      if (matching > 0) c[layer] += W_PATH * (matching / members.length);
    }
    const handlerFrac = members.filter(isRouteHandler).length / members.length;
    if (handlerFrac > 0) c.orchestration += W_HANDLER * handlerFrac;
  }

  // ── Source C: content signals
  if (members.length > 0) {
    const testFrac = members.filter((p) => TEST_PATH_RE.test(p)).length / members.length;
    if (testFrac >= TEST_FRACTION_MIN) c.ceremony += W_TEST * testFrac;
    const extFrac = members.filter((p) => NON_RUNTIME_EXT_RE.test(p)).length / members.length;
    if (extFrac >= EXT_FRACTION_MIN) c.ceremony += W_CEREMONY_EXT;
  }
  const labelSegs = new Set(input.frame_label.toLowerCase().split(/[/\s:_-]+/));
  for (const [layer, tokens] of PATH_LAYER_TABLE) {
    for (const seg of labelSegs) {
      if (tokens.has(seg)) {
        c[layer] += W_LABEL;
        break; // once per layer
      }
    }
  }

  // ── Combine: argmax, canonical tie-break, domain fallback below MIN_SIGNAL
  let best: FrameLayer = "domain";
  let bestScore = -1;
  for (const layer of LAYER_ORDER) {
    if (c[layer] > bestScore) {
      best = layer;
      bestScore = c[layer];
    }
  }
  if (bestScore < MIN_SIGNAL) {
    // No layer-specific source cleared the bar. If the middle-band runtime
    // residual does, domain is EARNED (not defaulted); otherwise fall back.
    if (domainResidual >= MIN_SIGNAL) {
      c.domain += domainResidual;
      best = "domain";
      bestScore = c.domain;
    } else {
      return { frame_id: input.frame_id, layer: "domain", confidence: 0, fallback: true, contributions: c };
    }
  }
  let second = 0;
  for (const layer of LAYER_ORDER) {
    if (layer !== best && c[layer] > second) second = c[layer];
  }
  const confidence = (bestScore - second) / bestScore;
  return { frame_id: input.frame_id, layer: best, confidence, fallback: false, contributions: c };
}

/** Eval harness + tests only — never serialize this shape. */
export function classifyFramesInternal(inputs: readonly FrameKindInput[]): FrameKindInternal[] {
  return inputs.map(classifyOne).sort((a, b) => a.frame_id - b.frame_id);
}

/** Production surface: one layer per frame, nothing else. */
export function classifyFrames(inputs: readonly FrameKindInput[]): FrameKind[] {
  return classifyFramesInternal(inputs).map(({ frame_id, layer }) => ({ frame_id, layer }));
}
