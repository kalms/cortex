import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHarness, callTool, type HarnessContext } from "./harness.js";

describe("show-tools contract", () => {
  let h: HarnessContext;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it("show is present in the tool list", async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name)).toContain("show");
  });

  it("focus without repo_path returns the MissingRepoPathError shape", async () => {
    const res = await callTool(h, "show", { repo_path: undefined, action: "focus", refs: [] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/repo_path required/);
  });

  describe("focus delivery via a capture server on CORTEX_VIEWER_PORT", () => {
    let server: ReturnType<typeof createServer>;
    let port: number;
    let requests: Array<{ path: string; body: unknown; headers: Record<string, string | string[] | undefined> }>;
    let prevPort: string | undefined;

    beforeAll(async () => {
      requests = [];
      server = createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          requests.push({
            path: req.url ?? "",
            body: raw ? JSON.parse(raw) : undefined,
            headers: req.headers,
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ version: 1, accepted: true }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      port = (server.address() as AddressInfo).port;
      prevPort = process.env.CORTEX_VIEWER_PORT;
      process.env.CORTEX_VIEWER_PORT = String(port);
    });

    afterAll(async () => {
      if (prevPort === undefined) delete process.env.CORTEX_VIEWER_PORT;
      else process.env.CORTEX_VIEWER_PORT = prevPort;
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    });

    it("delivers the focus body to the capture server and reports Spotlight set", async () => {
      const res = await callTool(h, "show", { action: "focus", refs: ["src/a.ts::fn"], note: "look here" });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("Spotlight set");
      expect(requests).toHaveLength(1);
      expect(requests[0].path).toBe("/api/show-focus");
      expect(requests[0].body).toMatchObject({
        refs: ["src/a.ts::fn"],
        note: "look here",
      });
      expect((requests[0].body as { repo_path: string }).repo_path).toBeTruthy();
    });

    it("omitting refs posts refs: [] and reports Spotlight cleared", async () => {
      const res = await callTool(h, "show", { action: "focus" });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("Spotlight cleared");
      const last = requests[requests.length - 1];
      expect(last.body).toMatchObject({ refs: [] });
    });
  });
});
