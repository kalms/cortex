import { describe, it, expect, afterEach } from "vitest";
import { cacheSlug, indexerCacheDir, slugCachePath, archiveRoot } from "../../src/db/store-paths.js";
import { homedir } from "node:os";
import { join } from "node:path";

describe("store-paths", () => {
  const saved = { cache: process.env.CTX_CACHE_DIR, home: process.env.CORTEX_HOME };
  afterEach(() => {
    process.env.CTX_CACHE_DIR = saved.cache;
    process.env.CORTEX_HOME = saved.home;
  });

  it("cacheSlug flattens an absolute path the way the indexer names its cache", () => {
    expect(cacheSlug("/Users/rka/Development/cortex")).toBe("Users-rka-Development-cortex");
  });

  it("indexerCacheDir defaults under ~/.cache and honors CTX_CACHE_DIR", () => {
    delete process.env.CTX_CACHE_DIR;
    expect(indexerCacheDir()).toBe(join(homedir(), ".cache", "cortex-indexer"));
    process.env.CTX_CACHE_DIR = "/tmp/x";
    expect(indexerCacheDir()).toBe("/tmp/x");
  });

  it("slugCachePath composes dir + slug + .db", () => {
    process.env.CTX_CACHE_DIR = "/tmp/x";
    expect(slugCachePath("/Users/rka/Development/cortex")).toBe("/tmp/x/Users-rka-Development-cortex.db");
  });

  it("archiveRoot lives under the durable home and honors CORTEX_HOME", () => {
    process.env.CORTEX_HOME = "/tmp/home";
    expect(archiveRoot()).toBe("/tmp/home/.cortex/_archive");
  });
});
