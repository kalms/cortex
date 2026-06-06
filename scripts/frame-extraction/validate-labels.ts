// scripts/frame-extraction/validate-labels.ts
/**
 * Lazy-loaded LLM glue for the eval-all `--validate` phase. Holds the ONLY Anthropic
 * SDK import in the eval — reached exclusively via dynamic import() under --validate,
 * so the default gate path never loads the SDK. Offline, internal-only, never per-user.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { IntruderTrial } from "./intruder.js";

const SNIPPET_MAX_CHARS = 800;

export interface TrialResult {
  cluster_id: number;
  label: string;
  f1: number;
  intruder_found: boolean;
}

export interface RunIntruderArgs {
  /** Clone path, for reading content snippets of candidate files. */
  repoPath: string;
  model: string;
  trials: IntruderTrial[];
  labelByCluster: Map<number, string>;
  f1ByCluster: Map<number, number>;
}

function snippet(repoPath: string, relPath: string): string {
  const abs = join(repoPath, relPath);
  if (!existsSync(abs)) return "(file not found)";
  return readFileSync(abs, "utf-8").slice(0, SNIPPET_MAX_CHARS);
}

async function askIntruder(
  client: Anthropic,
  model: string,
  label: string,
  candidates: { path: string; body: string }[],
): Promise<string> {
  const list = candidates.map((c, i) => `[${i}] ${c.path}\n${c.body}`).join("\n\n---\n\n");
  const msg = await client.messages.create({
    model,
    max_tokens: 16,
    messages: [
      {
        role: "user",
        content:
          `A group of files is described by the label "${label}". ` +
          `Exactly one of the files below does NOT belong to that group. ` +
          `Reply with ONLY its bracket index (e.g. "2").\n\n${list}`,
      },
    ],
  });
  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const m = text.match(/\d+/);
  return m ? candidates[Number(m[0])]?.path ?? "" : "";
}

/** Run one intruder trial per supplied trial; returns per-trial results. */
export async function runIntruderValidation(args: RunIntruderArgs): Promise<TrialResult[]> {
  const client = new Anthropic();
  const out: TrialResult[] = [];
  for (const t of args.trials) {
    const label = args.labelByCluster.get(t.cluster_id) ?? "";
    const candidates = t.candidates.map((p) => ({ path: p, body: snippet(args.repoPath, p) }));
    const chosen = await askIntruder(client, args.model, label, candidates);
    out.push({
      cluster_id: t.cluster_id,
      label,
      f1: args.f1ByCluster.get(t.cluster_id) ?? 0,
      intruder_found: chosen === t.intruder_path,
    });
  }
  return out;
}
