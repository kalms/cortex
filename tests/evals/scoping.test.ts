import { describe, it, expect } from "vitest";
import { selectAssertions } from "../../evals/src/assertions/registry.js";
import { selectTargets } from "../../evals/src/cli.js";
import type { Assertion, Target } from "../../evals/src/assertions/types.js";

const nuxtAssertion: Assertion = {
  fix_id: 5,
  name: "nuxt_thing",
  description: "a nuxt-specific assertion",
  query: { kind: "count_label", label: "function" },
  predicate: { op: "gt", value: 0 },
  baseline_expected: "fail",
  scope: "nuxt",
};

const universalAssertion: Assertion = {
  fix_id: "universal",
  name: "universal_thing",
  description: "a portable assertion",
  query: { kind: "count_label", label: "function" },
  predicate: { op: "gt", value: 0 },
  baseline_expected: "fail",
  scope: "universal",
  direction: "higher_is_better",
};

describe("assertion scoping", () => {
  const all = [nuxtAssertion, universalAssertion];

  it("selects only universal assertions for a universal-only target", () => {
    const got = selectAssertions(all, ["universal"]);
    expect(got.map((a) => a.name)).toEqual(["universal_thing"]);
  });

  it("selects both when the target declares both packs", () => {
    const got = selectAssertions(all, ["universal", "nuxt"]);
    expect(got.map((a) => a.name)).toEqual(["nuxt_thing", "universal_thing"]);
  });

  it("selects nothing for an empty pack list", () => {
    expect(selectAssertions(all, [])).toEqual([]);
  });
});

describe("suite selection", () => {
  const targets: Target[] = [
    { name: "elk", repo_url: "u", sha: "main", suites: ["nuxt"] },
    { name: "cobra", repo_url: "u", sha: "main", suites: ["corpus"] },
    { name: "nuxt-ui", repo_url: "u", sha: "main", suites: ["nuxt", "corpus"] },
    { name: "legacy", local_path: "/tmp/x" },
  ];

  it("defaults to the nuxt suite", () => {
    expect(selectTargets(targets, "nuxt").map((t) => t.name)).toEqual(["elk", "nuxt-ui", "legacy"]);
  });

  it("selects the corpus suite", () => {
    expect(selectTargets(targets, "corpus").map((t) => t.name)).toEqual(["cobra", "nuxt-ui"]);
  });

  it("selects everything for all", () => {
    expect(selectTargets(targets, "all").map((t) => t.name)).toEqual(["elk", "cobra", "nuxt-ui", "legacy"]);
  });
});
