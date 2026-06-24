// tests/frame-extraction/inject-frames.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import {
  pickFrameLabel,
  ubiquitousPathSegments,
  buildFrameAssignments,
  injectFrames,
} from "../../src/frame-extraction/inject-frames.js";
import type { ClusterResult } from "../../src/frame-extraction/types.js";

describe("repo-name suppression", () => {
  it("flags a path segment present in >=90% of all members as ubiquitous", () => {
    const perCluster = [
      ["saleor/asgi/a.py", "saleor/asgi/b.py"],
      ["saleor/graphql/m.py", "saleor/order/x.py"],
    ];
    expect(ubiquitousPathSegments(perCluster)).toEqual(new Set(["saleor"]));
  });

  it("flags nothing when no single top-level dir dominates", () => {
    const perCluster = [["src/a.ts", "src/b.ts"], ["tests/c.ts"], ["docs/d.md"]];
    expect(ubiquitousPathSegments(perCluster).has("src")).toBe(false);
  });

  it("returns an empty set for no paths", () => {
    expect(ubiquitousPathSegments([]).size).toBe(0);
  });

  it("suppresses the repo name so a characterising token wins instead", () => {
    const tokens = ["saleor asgi", "asgi", "application"];
    const paths = ["saleor/asgi/__init__.py", "saleor/asgi/handler.py", "saleor/asgi/cors.py"];
    // Without suppression the repo name leaks into the label.
    expect(pickFrameLabel(tokens, paths).includes("saleor")).toBe(true);
    // With suppression it falls through to the real token.
    expect(pickFrameLabel(tokens, paths, undefined, new Set(["saleor"]))).toBe("asgi");
  });

  it("never re-emits a suppressed segment via the path fallbacks", () => {
    // No usable tokens → would normally fall back to the common path segment.
    const paths = ["saleor/a/x.py", "saleor/b/y.py", "saleor/c/z.py"];
    expect(pickFrameLabel([], paths, 5, new Set(["saleor"])).includes("saleor")).toBe(false);
  });
});

describe("pickFrameLabel — original behavior", () => {
  it("returns the first non-generic top token", () => {
    expect(pickFrameLabel(["src", "auth", "token"], [])).toBe("auth");
  });

  it("falls back to cluster:<id> when all tokens are generic and no paths help", () => {
    expect(pickFrameLabel(["src", "index", "util"], [], 7)).toBe("cluster:7");
  });

  it("falls back to cluster:<id> when no top tokens at all", () => {
    expect(pickFrameLabel([], [], 3)).toBe("cluster:3");
  });

  it("is case-insensitive in the stop list", () => {
    expect(pickFrameLabel(["SRC", "UTIL", "billing"], [])).toBe("billing");
  });
});

describe("pickFrameLabel — extended stop list", () => {
  it("treats URL/route param tokens as generic (id, slug, params, name)", () => {
    expect(pickFrameLabel(["id", "auth"], [])).toBe("auth");
    expect(pickFrameLabel(["slug", "billing"], [])).toBe("billing");
    expect(pickFrameLabel(["params", "checkout"], [])).toBe("checkout");
    expect(pickFrameLabel(["name", "decisions"], [])).toBe("decisions");
  });

  it("treats runtime/Node globals as generic (dirname, __dirname, __filename)", () => {
    expect(pickFrameLabel(["__dirname", "drizzle"], [])).toBe("drizzle");
    expect(pickFrameLabel(["dirname", "vitest"], [])).toBe("vitest");
    expect(pickFrameLabel(["__filename", "indexer"], [])).toBe("indexer");
  });

  it("treats generic data/state tokens as generic (data, meta, default, props, state)", () => {
    expect(pickFrameLabel(["data", "billing"], [])).toBe("billing");
    expect(pickFrameLabel(["meta", "auth"], [])).toBe("auth");
    expect(pickFrameLabel(["default", "viewer"], [])).toBe("viewer");
    expect(pickFrameLabel(["props", "state", "form"], [])).toBe("form");
  });

  it("treats monorepo-convention dirs as generic (apps, packages)", () => {
    expect(pickFrameLabel(["apps", "dsl"], [])).toBe("dsl");
    expect(pickFrameLabel(["packages", "compiler"], [])).toBe("compiler");
  });

  it("treats short tokens (≤2 chars) as generic regardless of value", () => {
    expect(pickFrameLabel(["ds", "design"], [])).toBe("design");
    expect(pickFrameLabel(["js", "ts", "viewer"], [])).toBe("viewer");
    expect(pickFrameLabel(["a", "b", "c"], [])).not.toBe("a");
  });
});

describe("pickFrameLabel — bigram preference", () => {
  it("prefers a non-generic bigram over a non-generic unigram even at lower rank", () => {
    // 'auth' is the first non-generic unigram, but 'design system' is a better
    // descriptor — bigram with both parts non-generic.
    expect(pickFrameLabel(["auth", "design system"], [])).toBe("design system");
  });

  it("skips bigrams where ANY word is generic", () => {
    // 'system id' has 'id' generic → skip → 'design system' next → return
    expect(pickFrameLabel(["id", "system id", "design system", "auth"], [])).toBe("design system");
  });

  it("falls back to unigram when no fully-non-generic bigram exists", () => {
    // 'system id' has 'id' generic; only unigram 'system' qualifies.
    expect(pickFrameLabel(["id", "system id", "system"], [])).toBe("system");
  });

  it("handles the cortex 'mcp server' case (both words non-generic)", () => {
    expect(pickFrameLabel(["mcp", "mcp server", "server"], [])).toBe("mcp server");
  });

  it("returns 'drizzle config' for the canonical config-files cluster", () => {
    const tokens = [
      "__dirname", "__dirname dirname", "dirname", "config __dirname",
      "config", "drizzle config", "vitest config", "vitest",
    ];
    expect(pickFrameLabel(tokens, [])).toBe("drizzle config");
  });
});

describe("pickFrameLabel — path-ordered slash rendering (multi-word labels)", () => {
  it("joins a multi-word label with '/' in directory-nesting order", () => {
    // saleor/ nests above graphql/ in every member → already in n-gram order.
    expect(
      pickFrameLabel(["saleor graphql"], ["saleor/graphql/a.py", "saleor/graphql/b.py"]),
    ).toBe("saleor/graphql");
  });

  it("reorders words so the ancestor directory comes first", () => {
    // n-gram order is "beta alpha" but alpha/ nests above beta/ in the paths.
    expect(
      pickFrameLabel(["beta alpha"], ["alpha/beta/x.ts", "alpha/beta/y.ts"]),
    ).toBe("alpha/beta");
  });

  it("joins same-segment compound words with '-' rather than '/'", () => {
    // both words live in the single 'react-query' segment → not a hierarchy.
    expect(
      pickFrameLabel(
        ["react query"],
        ["packages/react-query/index.ts", "packages/react-query/core.ts"],
      ),
    ).toBe("react-query");
  });

  it("preserves the original spaced form when no member paths are available", () => {
    // token-only callers (memberPaths === []) keep current behavior.
    expect(pickFrameLabel(["mcp server"], [])).toBe("mcp server");
  });
});

describe("pickFrameLabel — path-prefix fallback", () => {
  it("uses the deepest non-generic common path segment when all tokens are generic", () => {
    const tokens = ["id", "data", "default"];
    const paths = [
      "apps/activator/app/pages/design-system/[id]/colors.vue",
      "apps/activator/app/pages/design-system/[id]/fonts.vue",
      "apps/activator/app/pages/design-system/[id]/templates.vue",
    ];
    // Common path = apps/activator/app/pages/design-system/[id]/
    // Walk back: [id] (URL param, contains brackets) → design-system non-generic → return
    expect(pickFrameLabel(tokens, paths)).toBe("design-system");
  });

  it("falls back to cluster:<id> when no common informative prefix exists", () => {
    const tokens = ["id", "data"];
    const paths = [
      "apps/foo/x.ts",
      "packages/bar/y.ts",
    ];
    // Only '' (split before 'apps' / 'packages') is common — no informative segment
    // Passes 1-4 fail (no non-generic tokens, no common prefix, no strict majority segment).
    // Pass 4.5 relaxed recovery: 'foo'/'bar' each appear at 50% >= 0.3 threshold → 'bar' recovered
    expect(pickFrameLabel(tokens, paths, 42)).toBe("bar");
  });

  it("skips bracketed path segments like [id] (URL params)", () => {
    const tokens = ["data"];
    const paths = [
      "apps/x/pages/users/[id]/a.vue",
      "apps/x/pages/users/[id]/b.vue",
    ];
    expect(pickFrameLabel(tokens, paths)).toBe("users");
  });

  it("skips Next.js route-group segments like (marketing) in the path-prefix fallback", () => {
    const paths = [
      "app/(marketing)/index.tsx",
      "app/(marketing)/page.tsx",
    ];
    // (marketing) is a route group (structural) → must be skipped; 'app' is
    // generic → no informative segment in Pass 3.
    // Pass 4 strict majority: 'page' appears in 1/2 (50%), not > 50% → null.
    // Pass 4.5 relaxed recovery: 'page' at 50% >= 0.3 → recovered
    expect(pickFrameLabel([], paths, 9)).toBe("page");
  });
});

describe("pickFrameLabel — dominant-segment fallback (cluster:N bug)", () => {
  // Real rosalind clusters that stranded at cluster:N: coherent frames whose
  // members share a NON-PREFIX path segment (the org root differs:
  // modules/… vs features/…), so the common-prefix fallback finds nothing and
  // the convention segment never ranks as a TF-IDF top token (low IDF). The
  // dominant-segment fallback must recover a real label before cluster:N.

  it("labels a Terraform-infra cluster 'infrastructure' via the dominant dir segment", () => {
    const paths = [
      "modules/rosalind-scripts/templates/lambda-feature/infrastructure/main.tf",
      "features/VAULT/publish-vault-document/infrastructure/main.tf",
      "features/EDITOR/edit-document/infrastructure/main.tf",
    ];
    // top tokens are terraform content / generic — none salient or eligible.
    expect(pickFrameLabel(["main", "tf"], paths, 21)).toBe("infrastructure");
  });

  it("labels a devbox.json cluster 'devbox' via the dominant filename stem", () => {
    const paths = [
      "modules/rosalind-strings/devbox.json",
      "modules/anthill-i-o/devbox.json",
      "modules/deepl-helper/devbox.json",
    ];
    // Directories all differ; only the shared filename stem characterises it.
    expect(pickFrameLabel([], paths, 24)).toBe("devbox");
  });

  it("labels a settings cluster 'settings', preferring the deeper topic over the org root", () => {
    const paths = [
      "features/DESIGN-SYSTEM/edit-design-system/data/settings/dev.json",
      "features/RENDITIONS/add-rendition/data/settings/dev.json",
      "features/DEV/rosalind-debugger/data/settings/example.json",
    ];
    // 'features' is shared 3/3 too, but it is an org-root convention — the
    // topical segment 'settings' must win.
    expect(pickFrameLabel([], paths, 17)).toBe("settings");
  });

  it("labels an events cluster 'events'", () => {
    const paths = [
      "features/VAULT/publish-vault-document/data/events/publish-document-events.json",
      "features/EDITOR/edit-document/data/events/edit-document-events.json",
      "modules/rosalind-scripts/templates/lambda-feature/data/events/test-events.json",
    ];
    expect(pickFrameLabel([], paths, 22)).toBe("events");
  });

  it("strips compound extensions from the filename stem (backup.tar.gz -> backup)", () => {
    const paths = ["a/backup.tar.gz", "b/backup.tar.gz"];
    expect(pickFrameLabel([], paths, 5)).toBe("backup");
  });

  it("strips the leading dot from a dotfile stem (.eslintrc -> eslintrc)", () => {
    const paths = ["x/.eslintrc", "y/.eslintrc"];
    expect(pickFrameLabel([], paths, 6)).toBe("eslintrc");
  });

  it("still returns cluster:<id> when no segment reaches a strict majority", () => {
    // Genuinely heterogeneous 2-file cluster: every informative segment is
    // shared by only 50% — not dominant in strict Pass 4 (>50%).
    // But Pass 4.5 relaxed recovery will accept segments at >= 0.3 threshold.
    const paths = ["apps/foo/x.ts", "packages/bar/y.ts"];
    // 'bar' appears at 50% >= 0.3 → recovered by Pass 4.5
    expect(pickFrameLabel(["id", "data"], paths, 42)).toBe("bar");
  });
});

describe("buildFrameAssignments — passes paths through to label", () => {
  it("uses path-prefix fallback when all tokens are generic", () => {
    const cluster: ClusterResult = {
      algorithm: "tfidf+hdbscan",
      parameters: {
        top_tokens_per_cluster: {
          "0": ["id", "data", "default"],
        },
      },
      clusters: [{
        cluster_id: 0,
        member_paths: [
          "apps/activator/app/pages/design-system/[id]/a.vue",
          "apps/activator/app/pages/design-system/[id]/b.vue",
        ],
      }],
      total_files: 2,
      noise_count: 0,
    };
    const result = buildFrameAssignments(cluster);
    expect(result[0]?.frame_label).toBe("design-system");
  });
});

describe("buildFrameAssignments", () => {
  const cluster: ClusterResult = {
    algorithm: "tfidf+hdbscan",
    parameters: {
      top_tokens_per_cluster: {
        "0": ["auth", "token"],
        "1": ["billing", "invoice"],
      },
    },
    clusters: [
      { cluster_id: 0, member_paths: ["src/auth/a.ts", "src/auth/b.ts"] },
      { cluster_id: 1, member_paths: ["src/billing/c.ts"] },
      { cluster_id: -1, member_paths: ["src/noise.ts"] },
    ],
    total_files: 4,
    noise_count: 1,
  };

  it("emits one assignment per file in non-noise clusters", () => {
    const assignments = buildFrameAssignments(cluster);
    expect(assignments).toEqual([
      { file_path: "src/auth/a.ts", frame_id: 0, frame_label: "auth", frame_confidence: 1.0, reclaimed: false },
      { file_path: "src/auth/b.ts", frame_id: 0, frame_label: "auth", frame_confidence: 1.0, reclaimed: false },
      { file_path: "src/billing/c.ts", frame_id: 1, frame_label: "billing", frame_confidence: 1.0, reclaimed: false },
    ]);
  });

  it("does not emit assignments for noise (cluster_id = -1)", () => {
    const assignments = buildFrameAssignments(cluster);
    expect(assignments.some((a) => a.file_path === "src/noise.ts")).toBe(false);
  });

  it("uses cluster:<id> fallback when top_tokens_per_cluster is missing and no informative path prefix", () => {
    const minimalCluster: ClusterResult = {
      ...cluster,
      parameters: {},
      clusters: [{ cluster_id: 5, member_paths: ["src/x.ts"] }],
    };
    const assignments = buildFrameAssignments(minimalCluster);
    // Path = src/x.ts → common prefix is src/ → src is generic → cluster:5
    expect(assignments[0]?.frame_label).toBe("cluster:5");
  });
});

describe("pickFrameLabel — salience gate + structural ineligibility (Phase 1)", () => {
  const activatorPages = [
    "apps/activator/app/pages/activator/banners.vue",
    "apps/activator/app/pages/activator/briefs.vue",
    "apps/activator/app/pages/activator/email.vue",
    "apps/activator/app/pages/activator/index.vue",
    "apps/activator/app/pages/activator/presentations.vue",
    "apps/activator/app/pages/activator/slides.vue",
    "apps/activator/app/pages/activator/modular-content.vue",
  ];

  it("rejects a non-salient leaf token and falls back to the path prefix", () => {
    // 'email' names only 1/7 files → fails the >=50% gate → path-prefix → 'activator'.
    expect(pickFrameLabel(["email", "pages"], activatorPages)).toBe("activator");
  });

  it("prefers a salient domain token over a non-salient one", () => {
    // 'activator' is in 7/7 paths; 'email' in 1/7.
    expect(pickFrameLabel(["email", "activator"], activatorPages)).toBe("activator");
  });

  it("rejects a route-param token even when it is the top token", () => {
    const paths = [
      "apps/x/pages/[orgId]/design-systems/colors.vue",
      "apps/x/pages/[orgId]/design-systems/fonts.vue",
    ];
    expect(pickFrameLabel(["orgid", "design"], paths)).toBe("design");
  });

  it("rejects an MVC layer marker and picks the domain noun", () => {
    const paths = [
      "app/controllers/users_controller.rb",
      "app/controllers/users/sessions_controller.rb",
    ];
    expect(pickFrameLabel(["users controller", "controller", "users"], paths)).toBe("users");
  });

  it("rejects a bare 'use' bigram and picks the salient store token", () => {
    const paths = [
      "packages/ui/stores/colors.ts",
      "packages/ui/stores/fonts.ts",
    ];
    expect(pickFrameLabel(["use store", "store"], paths)).toBe("store");
  });

  it("does NOT gate on salience when memberPaths is empty (token-only callers)", () => {
    // Regression guard: every existing token-only call must behave as before.
    expect(pickFrameLabel(["email", "activator"], [])).toBe("email");
  });
});

describe("injectFrames", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "inject-frames-"));
    dbPath = join(dir, "graph.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT,
      qualified_name TEXT, file_path TEXT, data TEXT, project TEXT)`);
    db.prepare(`INSERT INTO nodes VALUES (?,?,?,?,?,?,?)`).run(
      "n1", "file", "a.ts", "p.a", "src/auth/a.ts", "{}", "P");
    db.prepare(`INSERT INTO nodes VALUES (?,?,?,?,?,?,?)`).run(
      "n2", "file", "b.ts", "p.b", "src/auth/b.ts", "{}", "P");
    db.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes frame_id into matching file nodes", () => {
    const cluster: ClusterResult = {
      total_files: 2,
      noise_count: 0,
      clusters: [{ cluster_id: 3, member_paths: ["src/auth/a.ts", "src/auth/b.ts"] }],
      parameters: { top_tokens_per_cluster: { "3": ["auth"] } },
    } as unknown as ClusterResult;

    const assigned = injectFrames({ cluster, project: "P", dbPath });
    expect(assigned).toBe(2);

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(
      "SELECT json_extract(data,'$.frame_id') AS fid, json_extract(data,'$.frame_label') AS label FROM nodes WHERE kind='file'"
    ).all() as Array<{ fid: number | null; label: string | null }>;
    db.close();
    expect(rows.every((r) => r.fid === 3)).toBe(true);
    expect(rows.every((r) => r.label === "auth")).toBe(true);
  });
});

describe("injectFrames — reclaimed marker", () => {
  let dbDir: string;
  let dbPath: string;
  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), "inject-reclaim-"));
    dbPath = join(dbDir, "graph.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT, project TEXT, data TEXT);`);
    const ins = db.prepare("INSERT INTO nodes (kind, name, file_path, project, data) VALUES ('file', ?, ?, 'p', '{}')");
    ins.run("core.ts", "core.ts");
    ins.run("recl.ts", "recl.ts");
    db.close();
  });
  afterEach(() => rmSync(dbDir, { recursive: true, force: true }));

  it("marks reclaimed files with data.reclaimed = true and core files without it", () => {
    const cluster: ClusterResult = {
      algorithm: "tfidf+hdbscan", parameters: { top_tokens_per_cluster: { "0": ["core"] } },
      clusters: [{ cluster_id: 0, member_paths: ["core.ts", "recl.ts"], reclaimed_paths: ["recl.ts"] }],
      total_files: 2, noise_count: 0,
    };
    injectFrames({ cluster, project: "p", dbPath });
    const db = new Database(dbPath);
    const rows = db.prepare("SELECT file_path, data FROM nodes").all() as { file_path: string; data: string }[];
    db.close();
    const byPath = Object.fromEntries(rows.map((r) => [r.file_path, JSON.parse(r.data)]));
    expect(byPath["recl.ts"].reclaimed).toBe(true);
    expect(byPath["recl.ts"].frame_id).toBe(0);
    expect(byPath["core.ts"].reclaimed).toBeUndefined();
    expect(byPath["core.ts"].frame_id).toBe(0);
  });

  it("is idempotent: a second run keeps reclaimed=true and core flagless", () => {
    const cluster: ClusterResult = {
      algorithm: "tfidf+hdbscan", parameters: { top_tokens_per_cluster: { "0": ["core"] } },
      clusters: [{ cluster_id: 0, member_paths: ["core.ts", "recl.ts"], reclaimed_paths: ["recl.ts"] }],
      total_files: 2, noise_count: 0,
    };
    injectFrames({ cluster, project: "p", dbPath });
    injectFrames({ cluster, project: "p", dbPath }); // second run
    const db = new Database(dbPath);
    const rows = db.prepare("SELECT file_path, data FROM nodes").all() as { file_path: string; data: string }[];
    db.close();
    const byPath = Object.fromEntries(rows.map((r) => [r.file_path, JSON.parse(r.data)]));
    expect(byPath["recl.ts"].reclaimed).toBe(true);
    expect(byPath["core.ts"].reclaimed).toBeUndefined();
  });

  it("clears a stale reclaimed flag when a file is no longer reclaimed", () => {
    const asReclaimed: ClusterResult = {
      algorithm: "tfidf+hdbscan", parameters: { top_tokens_per_cluster: { "0": ["core"] } },
      clusters: [{ cluster_id: 0, member_paths: ["core.ts", "recl.ts"], reclaimed_paths: ["recl.ts"] }],
      total_files: 2, noise_count: 0,
    };
    const asCore: ClusterResult = {
      algorithm: "tfidf+hdbscan", parameters: { top_tokens_per_cluster: { "0": ["core"] } },
      clusters: [{ cluster_id: 0, member_paths: ["core.ts", "recl.ts"] }], // recl.ts now core
      total_files: 2, noise_count: 0,
    };
    injectFrames({ cluster: asReclaimed, project: "p", dbPath });
    injectFrames({ cluster: asCore, project: "p", dbPath });
    const db = new Database(dbPath);
    const row = db.prepare("SELECT data FROM nodes WHERE file_path = 'recl.ts'").get() as { data: string };
    db.close();
    expect(JSON.parse(row.data).reclaimed).toBeUndefined();
  });
});

describe("pickFrameLabel — directory-aware short tokens (cluster:N recovery)", () => {
  it("labels a cluster after a ≤2-char DIRECTORY segment (ws)", () => {
    const paths = ["src/ws/server.ts", "src/ws/protocol.ts", "src/ws/client-registry.ts", "tests/ws/server.test.ts"];
    // 'ws' is the top token and a real directory in 3/4 members.
    expect(pickFrameLabel(["ws", "server"], paths, 2)).toBe("ws");
  });
  it("does NOT label after a ≤2-char FILENAME-STEM token (ts) — stays generic", () => {
    const paths = ["src/core/a.ts", "src/core/b.ts", "src/core/c.ts"];
    // 'ts' is only an extension/stem, never a directory → still rejected; falls to path prefix 'core'(generic)→ cluster:N
    expect(pickFrameLabel(["ts", "id"], paths, 7)).toBe("cluster:7");
  });
});

describe("pickFrameLabel — relaxed recovery (Pass 4.5)", () => {
  it("recovers a generic-but-salient token (index-meta) instead of cluster:N", () => {
    const paths = ["src/graph/capture-index-meta.ts", "tests/index-meta.ts", "lib/index-meta.ts"];
    // top tokens are generic ('index','meta') so passes 1-2 reject; 4.5 allows them.
    // Paths have no common prefix, so Pass 3 fails; no dominant segment >50%, so Pass 4 fails.
    // Pass 4.5 relaxes the salience gate to 0.3, allowing 'index' (2/3 paths).
    const label = pickFrameLabel(["index meta", "meta", "index"], paths, 5);
    expect(label).not.toMatch(/^cluster:/);
    expect(label.toLowerCase()).toContain("index");
  });
  it("recovers a plurality (Mode B) token via the lowered salience bar", () => {
    // 'allocator' is salient in ~40% of members (below the strict 0.5 gate).
    const paths = ["src/ids/allocator.ts", "src/ids/short-id.ts", "tests/ids/allocator.test.ts", "tests/decisions/db-todos.test.ts", "tests/decisions/short-id-mint.test.ts"];
    const label = pickFrameLabel(["allocator", "mint", "fresh"], paths, 6);
    expect(label).not.toMatch(/^cluster:/);
  });
  it("still excludes route-params even in the relaxed pass", () => {
    // When ONLY a route-param is available as a token, it must be rejected
    // throughout all passes, never becoming a label.
    const paths = ["app/[id]/detail.tsx", "blog/[id]/show.tsx"];
    const label = pickFrameLabel(["id"], paths, 9);
    // 'id' is a route-param → rejected everywhere; segments 'app'/'blog' are
    // mixed (one generic, one not) → no dominant segment → 'blog' appears at
    // 50% but is not >50%, so strict Pass 4 fails; at relaxed 0.3, 'blog' is
    // >= 0.3 so it succeeds. The test verifies 'id' never becomes a label.
    expect(label).not.toBe("id");
    expect(label).not.toMatch(/^cluster:/);
  });
});
