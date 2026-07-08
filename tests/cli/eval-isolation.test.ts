import { describe, it, expect } from "vitest";
import { evalIndexerEnv } from "../../src/cli/commands/eval.js";

describe("evalIndexerEnv", () => {
  it("eval indexer env redirects cache + durable home into the eval scratch dir", () => {
    const env = evalIndexerEnv("/tmp/eval-scratch");
    expect(env.CTX_CACHE_DIR).toBe("/tmp/eval-scratch/cache");
    expect(env.CORTEX_HOME).toBe("/tmp/eval-scratch/home");
  });
});
