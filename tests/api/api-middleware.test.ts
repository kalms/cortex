import { describe, it, expect } from "vitest";
import {
  resolveBindHost, methodAllowed, corsHeadersFor, checkAuth, safeStaticPath, AUTH_EXEMPT, urlTooLong,
} from "../../src/mcp-server/api-middleware.js";
import { join, resolve } from "node:path";

describe("resolveBindHost", () => {
  it("defaults to loopback, honors override", () => {
    expect(resolveBindHost({})).toBe("127.0.0.1");
    expect(resolveBindHost({ CORTEX_BIND_HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });
});

describe("methodAllowed", () => {
  it("allows GET/HEAD, rejects others", () => {
    expect(methodAllowed("GET")).toBe(true);
    expect(methodAllowed("HEAD")).toBe(true);
    expect(methodAllowed("POST")).toBe(false);
    expect(methodAllowed(undefined)).toBe(false);
  });
});

describe("corsHeadersFor", () => {
  it("emits nothing without an allowlist", () => {
    expect(corsHeadersFor("https://x.dev", {})).toEqual({});
  });
  it("reflects an allowlisted origin only", () => {
    const env = { CORTEX_CORS_ORIGINS: "https://a.dev,https://b.dev" };
    expect(corsHeadersFor("https://a.dev", env)["Access-Control-Allow-Origin"]).toBe("https://a.dev");
    expect(corsHeadersFor("https://evil.dev", env)).toEqual({});
    expect(corsHeadersFor(undefined, env)).toEqual({});
  });
});

describe("checkAuth", () => {
  it("passes when no token configured", () => {
    expect(checkAuth("/api/graph", undefined, {})).toBe(true);
  });
  it("requires a matching bearer when token set", () => {
    const env = { CORTEX_API_TOKEN: "s3cret" };
    expect(checkAuth("/api/graph", "Bearer s3cret", env)).toBe(true);
    expect(checkAuth("/api/graph", "Bearer wrong", env)).toBe(false);
    expect(checkAuth("/api/graph", undefined, env)).toBe(false);
  });
  it("exempts /api/health even when token set", () => {
    expect(checkAuth("/api/health", undefined, { CORTEX_API_TOKEN: "s3cret" })).toBe(true);
    expect(AUTH_EXEMPT.has("/api/health")).toBe(true);
  });
});

describe("safeStaticPath", () => {
  const dir = resolve("/srv/viewer");
  it("resolves a normal file under the dir", () => {
    expect(safeStaticPath(dir, "viewer.js")).toBe(join(dir, "viewer.js"));
  });
  it("rejects traversal escapes", () => {
    expect(safeStaticPath(dir, "../../etc/passwd")).toBeNull();
    expect(safeStaticPath(dir, "../secret")).toBeNull();
  });
});

describe("urlTooLong", () => {
  it("flags only over-limit request targets", () => {
    expect(urlTooLong("/api/graph")).toBe(false);
    expect(urlTooLong("/api/graph?project=" + "a".repeat(3000))).toBe(true);
    expect(urlTooLong(undefined)).toBe(false);
  });
});
