import { mkdirSync, readFileSync, appendFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";

export function ledgerPath(repoPath: string): string {
  return join(repoPath, ".cortex", ".briefed");
}

export function wasBriefed(repoPath: string, target: string): boolean {
  try {
    const body = readFileSync(ledgerPath(repoPath), "utf8");
    return body.split("\n").some((l) => l === target);
  } catch {
    return false;
  }
}

export function markBriefed(repoPath: string, target: string): void {
  try {
    if (wasBriefed(repoPath, target)) return;
    const p = ledgerPath(repoPath);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, target + "\n");
  } catch {
    /* best-effort */
  }
}

export function clearBriefed(repoPath: string): void {
  try {
    rmSync(ledgerPath(repoPath), { force: true });
  } catch {
    /* best-effort */
  }
}
