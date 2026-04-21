import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    globalSetup: ["./tests/mcp-contract/globalSetup.ts"],
  },
});
