# Architecture Docs

Living architecture documents. Each one is owned by a particular slice
of the system; read the matching doc before working in that area.

| Doc | When to read |
|---|---|
| [graph-ui.md](graph-ui.md) | Event pipeline, WebSocket server, worker thread, frames viewer. Anything under `src/events/`, `src/ws/`, `src/viewer/`, or the HTTP layer in `src/mcp-server/api*.ts`. |
| [decisions-storage.md](decisions-storage.md) | The sidecar `.cortex/decisions.db` model — why decisions are not in the graph DB. Anything under `src/decisions/` or that touches the decision schema. |
| [frame-extraction.md](frame-extraction.md) | The TF-IDF + HDBSCAN + co-change pipeline that produces frames. Anything under `scripts/frame-extraction/` or `src/frame-extraction/`. |
| [eval-harness.md](eval-harness.md) | The tool-surface eval at `evals/`. Driven by the field assessment below. |
| [field-assessment-nuxt-monorepo.md](field-assessment-nuxt-monorepo.md) | The 2026-05-20 candid evaluation of Cortex on a Nuxt monorepo (anthill-cloud). Source of truth for "what's broken on Vue/Nuxt repos". |
| [known-limitations.md](known-limitations.md) | Active issues with known workarounds (most relevant: the C-indexer multi-project workflow). |

For the **algorithmic and product design** of frames, PRs, decisions,
the drawer, and merge animation, the authoritative reference is
[`docs/specs/cortex-v0.3/`](../specs/cortex-v0.3/) (start with its
`README.md`). The architecture docs above describe how those designs
are implemented in code; the specs describe what they should do.

For **execution plans** of features as they were built, see
[`docs/superpowers/`](../superpowers/).
