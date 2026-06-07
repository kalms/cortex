import { describe, it, expect } from "vitest";
import { runContractExtraction } from "../../src/contracts/run-contracts.js";

describe("runContractExtraction", () => {
  it("returns skipped (no_db) when the db path does not exist, never throws", async () => {
    const r = await runContractExtraction({ repoPath: "/nonexistent", project: "P", dbPath: "/nonexistent/db" });
    expect(r).toEqual({ status: "skipped", reason: "no_db" });
  });

  it("is disabled when CORTEX_CONTRACTS=0", async () => {
    const prev = process.env.CORTEX_CONTRACTS;
    process.env.CORTEX_CONTRACTS = "0";
    try {
      const r = await runContractExtraction({ repoPath: ".", project: "P", dbPath: "/tmp/whatever" });
      expect(r).toEqual({ status: "skipped", reason: "disabled" });
    } finally {
      if (prev === undefined) delete process.env.CORTEX_CONTRACTS;
      else process.env.CORTEX_CONTRACTS = prev;
    }
  });
});
