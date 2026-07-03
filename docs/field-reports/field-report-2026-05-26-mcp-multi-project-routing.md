# Field Report — MCP Multi-Project Routing: Indexed Projects Unreachable

**Date:** 2026-05-26
**Evaluator:** Claude (Opus 4.7, 1M context), session in `/Users/rka/Development/anthill-cloud`
**Subject:** Cortex MCP server — `list_projects`, `index_status`, and per-project tool routing
**Trigger:** User indexed a second repo (`/Users/rka/Development/activator/rosalind`) mid-session and asked me to use it. I couldn't.

This is a tight bug-focused report. The earlier 2026-05-26 follow-up covered CLI ergonomics and graph coverage; this one is about a hard failure mode in the MCP server's multi-project handling that surfaced in the same session.

---

## TL;DR

The Cortex indexer's graph store has 10 projects. The MCP tools running in this session can reach exactly **one** of them — the project matching the session's cwd. The other nine are visible *inside the error payload* when an unauthorized call is made (`available_projects: [...]` lists all ten), but no MCP tool method will route to them. Same Cortex binary, two views, out of sync.

For an LLM agent the practical impact is: a user can index a second repo, paste the success output to the agent, and the agent will still have to fall back to filesystem `ls` / `grep` because the indexed graph is unreachable through any MCP tool.

---

## Reproduction

Session was in `/Users/rka/Development/anthill-cloud`. The user had previously indexed it and, mid-session, indexed `/Users/rka/Development/activator/rosalind` separately. The user pasted the indexer success output to me:

```json
{
  "project": "Users-rka-Development-activator-rosalind",
  "status": "indexed",
  "nodes": 29836,
  "edges": 64078
}
```

The exact project name from that payload is `Users-rka-Development-activator-rosalind`. I then tried every reasonable MCP route to query it.

### 1. `list_projects` claims only one project exists

```
mcp__plugin_cortex_cortex__list_projects → 
  Users-rka-Development-anthill-cloud — /Users/rka/Development/anthill-cloud
  (indexed: 2026-05-25T22:33:50Z)
```

One result. Called twice, several minutes apart — same single-row output both times.

### 2. Addressing by name yields a self-contradictory error

```
mcp__plugin_cortex_cortex__get_architecture(
  project="Users-rka-Development-activator-rosalind",
  aspects=["all"]
)
```

→ Error:

```json
{
  "error": "project not found or not indexed",
  "hint":  "Use list_projects to see all indexed projects, then pass the project name.",
  "available_projects": [
    "Users-rka-Development-cortex-.tmp-frame-extraction-corpus-TanStack__table",
    "Users-rka-Development-cortex-.tmp-frame-extraction-corpus-trpc__trpc",
    "Users-rka-Development-cortex",
    "Users-rka-Development-cortex-.tmp-frame-extraction-corpus-pallets__click",
    "Users-rka-Development-cortex-.tmp-frame-extraction-corpus-huggingface__peft",
    "Users-rka-Development-cortex-.tmp-frame-extraction-corpus-nuxt__ui",
    "Users-rka-Development-anthill-cloud",
    "Users-rka-Development-cortex-.tmp-frame-extraction-corpus-spf13__cobra",
    "Users-rka-Development-cortex-.tmp-frame-extraction-corpus-vueuse__vueuse",
    "Users-rka-Development-activator-rosalind"
  ],
  "count": 10
}
```

The error payload's own `available_projects` array contains, verbatim, the exact string I passed in. It is project ten of ten in the list. The error message says it is "not found or not indexed."

This is internally contradictory inside a single tool response. Two code paths inside the binary disagree about which projects are reachable.

### 3. `index_status` by path also says no

```
mcp__plugin_cortex_cortex__index_status(path="/Users/rka/Development/activator/rosalind")
→ "No results: index_status(/Users/rka/Development/activator/rosalind)"
```

`/Users/rka/Development/activator/rosalind` is the exact path the user successfully indexed (proven by their pasted success output, which shows 29,836 nodes / 64,078 edges). The status lookup can't find it.

### 4. `search_graph` without a project doesn't help either

```
mcp__plugin_cortex_cortex__search_graph(name_pattern="webapp-frontend")
→ Error: "Repository not indexed. Run index_repository first."
```

No `project` parameter on this tool. It clearly resolves to *something* (some default project) and finds it not indexed — but the cwd's project (`Users-rka-Development-anthill-cloud`) is the one project `list_projects` *does* return as indexed. So even the implicit-cwd resolution is broken here.

### 5. `search_code` shells out to `grep` and bypasses the graph entirely

```
mcp__plugin_cortex_cortex__search_code(pattern="webapp-frontend")
→ ERROR reason=internal_error: 
  Command failed: grep -rn --exclude-dir=node_modules ... webapp-frontend .
```

`search_code` is documented as "graph-enriched" but the implementation visibly fell back to a plain `grep -rn` on `.` (the session cwd, which is anthill-cloud, where `webapp-frontend` doesn't exist). The grep failed because nothing matched, and the error was bubbled up as an internal error.

---

## What I think is happening

Without source-level visibility into the MCP server, the symptom pattern reads like:

- The indexer's graph store knows about 10 projects (we have a verbatim list).
- `list_projects` is reading from a *different* registry — maybe scoped to the MCP session's startup-time cwd, maybe a stale cache, maybe a hardcoded "active project" the MCP picked at boot and never re-resolves.
- Per-call `project=` parameters are being silently dropped or filtered against the same scoped registry, so the tool can't route to projects outside the MCP's startup scope.
- `index_status` accepts a `path` argument but resolves it against the same scoped registry, not the indexer's master path→project map.
- `search_code`'s graph-enriched path isn't routing at all in this MCP instance — it's falling through to a `grep` shell-out as if no project were configured.

The MCP server appears to have been bound to a single project at process start, and "multi-project" only works if every reachable project happened to be registered before that process started.

## Why this matters for agent workflows

The user's workflow here was textbook: "I'm going to index this second repo, then ask the agent to analyze it." That's the natural thing to do when investigating a system you don't yet own. From the agent's perspective every signal said the index existed (success output, 29k nodes, the project name appearing in the error's own `available_projects`), but no tool call could reach it. The fallback was `find` + `cat` + reading `package.json` files by hand.

Compounding factor: the failure mode is not loud. `list_projects` doesn't say "9 projects are indexed but unreachable from this session." It just returns one row, as if one row were the complete truth. A less-careful agent would tell the user "the project isn't indexed yet — try `index_repository`," when in fact it's been indexed for hours.

## What worked around it

Nothing in MCP. The local clone of the second repo was available at `/Users/rka/Development/activator/rosalind`, and `git fetch + checkout` against the snapshot commit gave me the source. From there: `ls`, `jq` on `package.json`, `cat` on per-feature `*.md` notes. The output was an architecture description and Mermaid diagram for a 134-package monorepo — fine, but graph-grounded callers / dependency edges would have been more accurate and much faster.

The same task with a working `get_architecture(project=…, aspects=["all"])` against the rosalind index would have been ~1 tool call instead of ~12 shell calls.

---

## Recommendations, ordered

1. **Make `list_projects` authoritative.** It should return every project the indexer's graph store knows about, not whatever subset the MCP server picked up at boot. If "scope" is a real concept the server enforces, it should be visible (`scope: "session-cwd"`) and overridable rather than silent.
2. **Honor the `project=` parameter on every tool that accepts it.** If `get_architecture(project="X")` is going to reject `X`, that rejection cannot come back in the same response that lists `X` as available. Either the parameter routes, or the tool shouldn't expose the parameter.
3. **Align `index_status(path=…)` with the indexer's master path→project map.** The path the user just indexed should resolve. If it doesn't, that's a registry-sync bug worth a guard test.
4. **Surface the "indexed but unreachable" failure mode explicitly.** If the MCP knows the indexer has 10 projects but it can only route to 1, the error message agents see should say so directly — not "project not found." Today's payload is a near-miss: it includes `available_projects`, but the human-readable `error` field contradicts that list.
5. **Investigate why `search_code` fell through to `grep -rn`.** Documented as graph-enriched; observed as a plain grep shell-out. Whether this is the same routing failure (no project resolved → fall back to grep) or a separate code path, the fallback shouldn't be silent.
6. **Document the MCP server reload path.** This is solvable with a process restart if the user knows to do it. The Cortex docs and the SessionStart hook copy could call this out — "if `list_projects` and the indexer disagree, restart the MCP server."

---

## Net assessment

The indexer is fine — it indexed 29,836 nodes / 64,078 edges of a Rosalind monorepo in the time it took me to do something else. The MCP server in front of it isn't keeping up with the indexer's view of the world. That's a much smaller fix than the Vue-parser gap discussed in the sibling 2026-05-26 report, and it has higher leverage because every cross-project workflow runs through this same routing layer.

For an LLM agent the operational rule until this is fixed is: *don't trust `list_projects`*. If the user pastes indexer success output, treat the project as indexed, attempt the call once, and if the routing fails, fall back to the filesystem and tell the user to reload the MCP. Don't tell them to re-index.
