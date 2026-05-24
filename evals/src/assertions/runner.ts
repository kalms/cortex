import { GraphStore } from "../../../src/graph/store.js";
import type { Assertion, AssertionResult, Predicate } from "./types.js";

export type RunnerContext = {
  dbPath: string;
};

export function runAssertion(a: Assertion, ctx: RunnerContext): AssertionResult {
  const store = new GraphStore(ctx.dbPath);

  let observed: number | string[];
  switch (a.query.kind) {
    case "count_label": {
      const row = store.queryRaw<{ n: number }>(
        "SELECT COUNT(*) AS n FROM nodes WHERE kind = ?",
        [a.query.label],
      )[0];
      observed = row?.n ?? 0;
      break;
    }
    case "count_edge": {
      const row = store.queryRaw<{ n: number }>(
        "SELECT COUNT(*) AS n FROM edges WHERE relation = ?",
        [a.query.type],
      )[0];
      observed = row?.n ?? 0;
      break;
    }
    case "sql": {
      const rows = store.queryRaw<Record<string, unknown>>(a.query.sql);
      if (a.predicate.op === "matches" || a.predicate.op === "no_match") {
        observed = rows.map((r) => String(Object.values(r)[0] ?? ""));
      } else {
        // Numeric predicate. If the SQL returns a single row whose first column
        // is a number (e.g. SELECT COUNT(*) AS n), use that value. Otherwise
        // fall back to row count.
        const first = rows[0];
        const firstVal = first ? Object.values(first)[0] : undefined;
        observed = typeof firstVal === "number" && rows.length === 1
          ? firstVal
          : rows.length;
      }
      break;
    }
    case "tool_call":
      throw new Error(
        `runAssertion: tool_call query kind not supported here — use runToolAssertion from tool-runner.ts`,
      );
  }

  const passed = evaluatePredicate(a.predicate, observed);
  const surprised =
    (a.baseline_expected === "pass" && !passed) ||
    (a.baseline_expected === "fail" && passed);

  return { assertion: a, observed, passed, surprised };
}

function evaluatePredicate(p: Predicate, observed: number | string[]): boolean {
  switch (p.op) {
    case "gt":
      return typeof observed === "number" && observed > p.value;
    case "gte":
      return typeof observed === "number" && observed >= p.value;
    case "eq":
      return typeof observed === "number" && observed === p.value;
    case "matches": {
      if (!Array.isArray(observed)) return false;
      const re = new RegExp(p.regex);
      return observed.every((row) => re.test(row));
    }
    case "no_match": {
      if (!Array.isArray(observed)) return false;
      const re = new RegExp(p.regex);
      return !observed.some((row) => re.test(row));
    }
    case "tool_text_nonempty":
    case "tool_text_contains":
      throw new Error(
        "evaluatePredicate: tool_* predicates require runToolAssertion, not runAssertion",
      );
  }
}
