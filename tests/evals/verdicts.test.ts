import { describe, it, expect } from "vitest";
import { applyRatchet } from "../../evals/src/assertions/verdicts.js";
import type {
  Assertion,
  AssertionResult,
  Baseline,
  RatchetDirection,
  RatchetOutcome,
} from "../../evals/src/assertions/types.js";

function universal(name: string, direction: RatchetDirection): Assertion {
  return {
    fix_id: "universal",
    name,
    description: "",
    query: { kind: "sql", sql: "" },
    baseline_expected: "pass",
    scope: "universal",
    direction,
  };
}

// applyRatchet's map branch keys the proportional density tolerance off the
// assertion's query kind, not off the metric name, so a density test needs
// query: { kind: "language_density" } rather than universal()'s sql stub.
function density(): Assertion {
  return {
    fix_id: "universal",
    name: "per_language_function_density",
    description: "",
    query: { kind: "language_density" },
    baseline_expected: "pass",
    scope: "universal",
    direction: "higher_is_better",
  };
}

function result(a: Assertion, observed: AssertionResult["observed"]): AssertionResult {
  return { assertion: a, observed, passed: null, surprised: false };
}

function baseline(per: Baseline["per_assertion"]): Baseline {
  return { target: "demo", captured_at: "", nodes_by_label: {}, edges_by_type: {}, per_assertion: per };
}

const asMap = (r: AssertionResult) => r.ratchet as Record<string, RatchetOutcome>;

describe("applyRatchet", () => {
  it("fails a universal metric that moved the wrong way", () => {
    const [r] = applyRatchet(
      [result(universal("file_sourced_calls", "lower_is_better"), 12)],
      baseline({ file_sourced_calls: 0 }),
    );
    expect(r!.passed).toBe(false);
    expect(r!.surprised).toBe(true);
  });

  it("passes a metric that is bad but stable", () => {
    const [r] = applyRatchet(
      [result(universal("call_attribution_rate", "higher_is_better"), 40)],
      baseline({ call_attribution_rate: 40 }),
    );
    expect(r!.passed).toBe(true);
  });

  it("reports an unmeasurable metric as not_measured, never as a pass", () => {
    const [r] = applyRatchet(
      [result(universal("call_attribution_rate", "higher_is_better"), null)],
      baseline({ call_attribution_rate: 92 }),
    );
    expect(r!.passed).toBeNull();
    expect(r!.ratchet).toMatchObject({ status: "not_measured" });
  });

  it("leaves passed null when there is no baseline", () => {
    const [r] = applyRatchet([result(universal("qn_collisions", "lower_is_better"), 3)], null);
    expect(r!.passed).toBeNull();
    expect(r!.surprised).toBe(false);
  });

  it("records an improvement beyond epsilon", () => {
    const [r] = applyRatchet(
      [result(universal("file_sourced_calls", "lower_is_better"), 0)],
      baseline({ file_sourced_calls: 147 }),
    );
    expect(r!.passed).toBe(true);
    expect(r!.ratchet).toMatchObject({ status: "pass", improved: true });
  });

  it("judges a map-valued metric per language and fails on any regression", () => {
    const [r] = applyRatchet(
      [result(universal("per_language_function_density", "higher_is_better"), { go: 0, ts: 4.2 })],
      baseline({ per_language_function_density: { go: 3.1, ts: 4.2 } }),
    );
    expect(r!.passed).toBe(false);
    expect(asMap(r!).go!.status).toBe("fail");
    expect(asMap(r!).ts!.status).toBe("pass");
  });

  it("treats a language present at baseline and absent now as a regression to zero", () => {
    const [r] = applyRatchet(
      [result(universal("per_language_function_density", "higher_is_better"), { ts: 4.2 })],
      baseline({ per_language_function_density: { rb: 2.0, ts: 4.2 } }),
    );
    expect(r!.passed).toBe(false);
    expect(asMap(r!).rb!.status).toBe("fail");
  });

  it("leaves a nuxt-scoped result untouched", () => {
    const a: Assertion = {
      fix_id: 5,
      name: "nitro_handlers",
      description: "",
      query: { kind: "sql", sql: "" },
      predicate: { op: "gt", value: 0 },
      baseline_expected: "fail",
      scope: "nuxt",
    };
    const input: AssertionResult = { assertion: a, observed: 3, passed: true, surprised: true };
    const [r] = applyRatchet([input], baseline({ nitro_handlers: 0 }));
    expect(r!.passed).toBe(true);
    expect(r!.ratchet).toBeUndefined();
  });

  it("tolerates density drift within 10% of that language's baseline", () => {
    const [r] = applyRatchet(
      [result(density(), { ts: 1.1 })],
      baseline({ per_language_function_density: { ts: 1.2 } }),
    );
    expect(r!.passed).toBe(true);
  });

  it("fails a density drop beyond 10% of that language's baseline", () => {
    const [r] = applyRatchet(
      [result(density(), { ts: 1.0 })],
      baseline({ per_language_function_density: { ts: 1.2 } }),
    );
    expect(r!.passed).toBe(false);
  });

  it("fails a sparse language that vanished, which a fixed 0.5 epsilon would have passed", () => {
    const [r] = applyRatchet(
      [result(density(), { ts: 1.2 })],
      baseline({ per_language_function_density: { ts: 1.2, rb: 0.4 } }),
    );
    expect(r!.passed).toBe(false);
    expect((r!.ratchet as Record<string, { status: string }>).rb!.status).toBe("fail");
  });
});
