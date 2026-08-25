import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    globalSetup: ["./tests/mcp-contract/globalSetup.ts"],
    env: {
      // Indexing provisions the frames venv on demand (ensureVenv). A test
      // suite must not spend minutes and a network doing that, and on a
      // machine without a venv it turned every index-path test into a
      // timeout. Tests that exercise provisioning delete this themselves.
      CORTEX_FRAMES_SETUP: "0",
    },
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // Survey corpus checkouts under .tmp/frame-extraction/corpus/ carry
      // their own test suites which vitest must not pick up.
      "**/.tmp/**",
    ],
  },
});
