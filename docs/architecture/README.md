# Architecture Docs

Living architecture documents. Each one is owned by a particular slice
of the system; read the matching doc before working in that area.

| Doc | When to read |
|---|---|
| [../mcp-tools.md](../mcp-tools.md) | The full MCP tool catalog — every tool's purpose, params, return shape, and the `repo_path` routing contract + error shapes. Read before working under `src/mcp-server/tools/`. |
| [graph-ui.md](graph-ui.md) | Event pipeline, WebSocket server, worker thread, frames viewer. Anything under `src/events/`, `src/ws/`, `src/viewer/`, or the HTTP layer in `src/mcp-server/api*.ts`. |
| [show-your-work.md](show-your-work.md) | The live presence pipeline (hook → `/api/presence` → `presence.activity` → viewer avatars/traversal/heat) — slice 1 of the show-your-work design. Anything touching `hooks/show-presence.sh`, `POST /api/presence`'s registry gate (`beacon-target.ts`), or `canvas/presence.js`/`PresenceStrip.tsx`. |
| [graph-storage.md](graph-storage.md) | Where graphs live: canonical `<repo>/.cortex/db`, the central project registry (`_registry.db`), the legacy cache + migration, the read/write path resolution, and the **freshness signal** (per-read staleness verdict + SessionStart auto-refresh). Anything under `src/db/` or the index write/read paths. |
| [decisions-storage.md](decisions-storage.md) | The durable out-of-repo decisions sidecar (`~/.cortex/<repoId>/decisions.db`) — why decisions are not in the graph DB, and why the store lives outside the repo. Anything under `src/decisions/` or that touches the decision schema. |
| [staleness-detection.md](staleness-detection.md) | Index-time staleness detection for authored content — what the basis hash proves (and does not), the three populations, the sweep-before-`captureIndexMeta` ordering contract, and why the output is triage-only. Anything under `src/staleness/` or the index post-passes. |
| [frame-extraction.md](frame-extraction.md) | The TF-IDF + HDBSCAN + co-change pipeline that produces frames. Anything under `scripts/frame-extraction/` or `src/frame-extraction/`. |
| [frame-extraction-design.md](frame-extraction-design.md), [frame-ranking-design.md](frame-ranking-design.md), [frame-layout-design.md](frame-layout-design.md), [todo-entity-design.md](todo-entity-design.md) | The settled v0.3 design notes (promoted 2026-07-03): what frames/ranking/layout/TODOs *should do*. The implementation docs above describe how they do it. |
| [eval-harness.md](eval-harness.md) | The tool-surface eval at `evals/`. Driven by the field reports (see below). |
| [known-limitations.md](known-limitations.md) | Active issues with known workarounds (most relevant: the C-indexer multi-project workflow). |

The settled v0.3 design notes now live in this directory (the
`*-design.md` rows above). The remaining v0.3 material — the original
multiplayer spec, backlog, research brief, and visual prototype — is
archived at [`docs/specs/archive/cortex-v0.3/`](../specs/archive/cortex-v0.3/).

For **field reports** — candid, dated evaluations of Cortex run against
real repos (the source of truth for "what's broken in the wild" and the
motivation behind the eval harness) — see
[`docs/field-reports/`](../field-reports/). The standout is the
[2026-05-20 Nuxt-monorepo assessment](../field-reports/field-assessment-nuxt-monorepo.md).
