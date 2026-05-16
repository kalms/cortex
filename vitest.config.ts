import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    globalSetup: ["./tests/mcp-contract/globalSetup.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // Survey corpus checkouts under .tmp/frame-extraction/corpus/ carry
      // their own test suites which vitest must not pick up.
      "**/.tmp/**",
    ],
  },
});
