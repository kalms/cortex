import type { Binding, ContractMismatch, CoverageReport } from "./types.js";

export interface GroupedContract {
  providerKeys: Set<string>;
  consumerKeys: Set<string>;
  providers: number;
  consumers: number;
}

/** Group bindings by tool, unioning keys across multiple call sites per side. */
export function groupBindings(bindings: readonly Binding[]): Map<string, GroupedContract> {
  const out = new Map<string, GroupedContract>();
  for (const b of bindings) {
    let g = out.get(b.tool);
    if (!g) {
      g = { providerKeys: new Set(), consumerKeys: new Set(), providers: 0, consumers: 0 };
      out.set(b.tool, g);
    }
    const dst = b.role === "provides" ? g.providerKeys : g.consumerKeys;
    for (const k of b.keys) dst.add(k);
    if (b.role === "provides") g.providers++; else g.consumers++;
  }
  return out;
}

export function diffKeys(
  providerKeys: readonly string[],
  consumerKeys: readonly string[],
): { missing_on_provider: string[]; missing_on_consumer: string[] } {
  const p = new Set(providerKeys), c = new Set(consumerKeys);
  return {
    missing_on_provider: [...c].filter((k) => !p.has(k)).sort(),
    missing_on_consumer: [...p].filter((k) => !c.has(k)).sort(),
  };
}

/** Mismatches over tools that have BOTH a provider and a consumer. */
export function findMismatches(bindings: readonly Binding[]): ContractMismatch[] {
  const out: ContractMismatch[] = [];
  for (const [tool, g] of groupBindings(bindings)) {
    if (g.providers === 0 || g.consumers === 0) continue; // one-sided → coverage, not mismatch
    const d = diffKeys([...g.providerKeys], [...g.consumerKeys]);
    if (d.missing_on_provider.length || d.missing_on_consumer.length) {
      out.push({
        tool,
        provider_keys: [...g.providerKeys].sort(),
        consumer_keys: [...g.consumerKeys].sort(),
        ...d,
      });
    }
  }
  return out.sort((a, b) => a.tool.localeCompare(b.tool));
}

export function summarizeCoverage(bindings: readonly Binding[], unrecognized: number): CoverageReport {
  const g = groupBindings(bindings);
  let providers = 0, consumers = 0, matched = 0;
  const provider_only: string[] = [], consumer_only: string[] = [];
  for (const [tool, c] of g) {
    providers += c.providers;
    consumers += c.consumers;
    if (c.providers > 0 && c.consumers > 0) matched++;
    else if (c.providers > 0) provider_only.push(tool);
    else consumer_only.push(tool);
  }
  return {
    anchors: g.size,
    providers,
    consumers,
    matched,
    provider_only: provider_only.sort(),
    consumer_only: consumer_only.sort(),
    unrecognized,
  };
}
