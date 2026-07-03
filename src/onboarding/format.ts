import type { HotspotArea } from "../architecture/types.js";
import type { EntryPoint } from "./entrypoints.js";

export interface OnboardingFacts {
  files: number; nodes: number; edges: number;
  hotspots: HotspotArea[]; entrypoints: EntryPoint[];
}

/** Bounded (≤8-line) onboarding headline. Pure. Empty facts → "". */
export function formatOnboarding(f: OnboardingFacts): string {
  if (f.hotspots.length === 0 && f.entrypoints.length === 0) return "";
  const lines: string[] = [];
  lines.push(`▸ ${f.files} files · ${f.nodes} nodes / ${f.edges} edges`);
  if (f.hotspots.length) {
    lines.push(`  Hotspots (inbound fan-in): ${f.hotspots.slice(0, 5).map((h) => h.module).join(", ")}`);
  }
  if (f.entrypoints.length) {
    const eps = f.entrypoints.slice(0, 4)
      .map((e) => (e.label === "entry" ? e.target : `${e.label} → ${e.target}`)).join(" · ");
    lines.push(`  Entrypoints: ${eps}`);
  }
  lines.push(`  Map: cortex code arch --hotspots  ·  get_architecture(aspects=["hotspots"])`);
  return lines.join("\n");
}
