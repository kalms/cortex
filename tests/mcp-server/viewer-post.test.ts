import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingHttpHeaders } from "node:http";
import { postToViewer } from "../../src/mcp-server/tools/viewer-post.js";

interface CapturedRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

interface CaptureServer {
  port: number;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

/** Ephemeral node:http server that records requests and always ACKs with
 *  {version:1, accepted:true} — the real viewer's show-focus response shape. */
function startCaptureServer(): Promise<CaptureServer> {
  return new Promise((resolve) => {
    const requests: CapturedRequest[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        requests.push({
          path: req.url ?? "",
          headers: req.headers,
          body: raw ? JSON.parse(raw) : undefined,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ version: 1, accepted: true }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ port, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe("postToViewer", () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it("hits CORTEX_VIEWER_PORT first when set, delivering the body", async () => {
    const capture = await startCaptureServer();
    try {
      const result = await postToViewer(
        "/api/show-focus",
        { repo_path: "/x", refs: ["a"] },
        { CORTEX_VIEWER_PORT: String(capture.port) },
      );
      expect(result).toEqual({ delivered: true, accepted: true });
      expect(capture.requests).toHaveLength(1);
      expect(capture.requests[0].path).toBe("/api/show-focus");
      expect(capture.requests[0].body).toEqual({ repo_path: "/x", refs: ["a"] });
      expect(capture.requests[0].headers["content-type"]).toContain("application/json");
    } finally {
      await capture.close();
    }
  });

  it("sends an Authorization: Bearer header when CORTEX_API_TOKEN is set", async () => {
    const capture = await startCaptureServer();
    try {
      await postToViewer(
        "/api/show-focus",
        { refs: [] },
        { CORTEX_VIEWER_PORT: String(capture.port), CORTEX_API_TOKEN: "sekret" },
      );
      expect(capture.requests[0].headers["authorization"]).toBe("Bearer sekret");
    } finally {
      await capture.close();
    }
  });

  it("omits the Authorization header when CORTEX_API_TOKEN is unset", async () => {
    const capture = await startCaptureServer();
    try {
      await postToViewer("/api/show-focus", { refs: [] }, { CORTEX_VIEWER_PORT: String(capture.port) });
      expect(capture.requests[0].headers["authorization"]).toBeUndefined();
    } finally {
      await capture.close();
    }
  });

  it("falls back through candidate ports in order: env, 3333, 3334", async () => {
    const calledUrls: string[] = [];
    global.fetch = vi.fn(async (url: unknown) => {
      calledUrls.push(String(url));
      if (String(url).includes(":9999")) throw new Error("connection refused");
      if (String(url).includes(":3333")) throw new Error("connection refused");
      return new Response(JSON.stringify({ version: 1, accepted: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await postToViewer("/api/show-focus", { refs: [] }, { CORTEX_VIEWER_PORT: "9999" });
    expect(result).toEqual({ delivered: true, accepted: true });
    expect(calledUrls).toEqual([
      "http://127.0.0.1:9999/api/show-focus",
      "http://127.0.0.1:3333/api/show-focus",
      "http://127.0.0.1:3334/api/show-focus",
    ]);
  });

  it("dedupes candidate ports when CORTEX_VIEWER_PORT equals a conventional port", async () => {
    const calledUrls: string[] = [];
    global.fetch = vi.fn(async (url: unknown) => {
      calledUrls.push(String(url));
      throw new Error("down");
    }) as unknown as typeof fetch;

    await postToViewer("/api/show-focus", { refs: [] }, { CORTEX_VIEWER_PORT: "3333" });
    expect(calledUrls).toEqual([
      "http://127.0.0.1:3333/api/show-focus",
      "http://127.0.0.1:3334/api/show-focus",
    ]);
  });

  it("skips an empty CORTEX_VIEWER_PORT rather than trying it", async () => {
    const calledUrls: string[] = [];
    global.fetch = vi.fn(async (url: unknown) => {
      calledUrls.push(String(url));
      throw new Error("down");
    }) as unknown as typeof fetch;

    await postToViewer("/api/show-focus", { refs: [] }, { CORTEX_VIEWER_PORT: "" });
    expect(calledUrls).toEqual([
      "http://127.0.0.1:3333/api/show-focus",
      "http://127.0.0.1:3334/api/show-focus",
    ]);
  });

  it("treats a non-2xx response as a failed candidate and tries the next one", async () => {
    const calledUrls: string[] = [];
    global.fetch = vi.fn(async (url: unknown) => {
      calledUrls.push(String(url));
      if (String(url).includes(":9999")) return new Response("nope", { status: 500 });
      return new Response(JSON.stringify({ version: 1, accepted: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await postToViewer("/api/show-focus", { refs: [] }, { CORTEX_VIEWER_PORT: "9999" });
    expect(result).toEqual({ delivered: true, accepted: true });
    expect(calledUrls).toEqual([
      "http://127.0.0.1:9999/api/show-focus",
      "http://127.0.0.1:3333/api/show-focus",
    ]);
  });

  it("returns {delivered:false, accepted:false} without throwing when every candidate is unreachable", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await postToViewer("/api/show-focus", { refs: [] }, { CORTEX_VIEWER_PORT: "9999" });
    expect(result).toEqual({ delivered: false, accepted: false });
  });

  it("returns {delivered:false} without throwing when the request times out", async () => {
    global.fetch = vi.fn((_url: unknown, opts: unknown) => {
      const signal = (opts as { signal: AbortSignal }).signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("This operation was aborted")));
      });
    }) as unknown as typeof fetch;

    const result = await postToViewer("/api/show-focus", { refs: [] }, { CORTEX_VIEWER_PORT: "9999" });
    expect(result).toEqual({ delivered: false, accepted: false });
  }, 5000);

  it("reports accepted:false when the viewer 2xx-acks but rejects (different repo)", async () => {
    const capture = await startCaptureServer();
    // Override the capture server's canned response for this one test by
    // pointing at a second server that acks with accepted:false.
    await capture.close();
    const server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ version: 1, accepted: false }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    try {
      const result = await postToViewer("/api/show-focus", { refs: [] }, { CORTEX_VIEWER_PORT: String(port) });
      expect(result).toEqual({ delivered: true, accepted: false });
    } finally {
      await new Promise((r) => server.close(() => r(undefined)));
    }
  });
});
