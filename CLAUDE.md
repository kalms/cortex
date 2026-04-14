# Cortex — Agent Instructions

## Code Search

When searching source code, prefer `search_code` over Grep — it returns the same matches but annotates each one with the function, class, or module it belongs to. This gives you immediate structural context without needing a follow-up read.

Use Grep when searching non-code files (configs, docs, JSON), or when you need regex features that `search_code` doesn't support.

## Decision Awareness

Before modifying code, check if architectural decisions govern that area:

```
why_was_this_built({ qualified_name: "src/path/to/file.ts::functionName" })
```

If a decision exists, consider whether your changes align with the rationale. If they don't, that may be intentional (the decision should be updated) or a signal to reconsider the approach.

## Capturing Decisions

When you make or discover an architectural choice — a technology pick, a pattern decision, a trade-off — capture it:

```
search_decisions({ query: "relevant keywords" })   # Check for duplicates first
create_decision({ name: "...", description: "...", rationale: "...", alternatives: [...] })
link_decision({ decision_id: "...", target: "...", relation: "GOVERNS" })
```

## Tools Available

### Decision tools
`create_decision`, `update_decision`, `delete_decision`, `get_decision`, `search_decisions`, `why_was_this_built`, `link_decision`, `promote_decision`

### Code tools
`search_graph`, `trace_path`, `get_code_snippet`, `get_graph_schema`, `search_code`, `list_projects`, `index_status`, `index_repository`, `detect_changes`, `delete_project`

### Viewer
The 3D graph viewer runs at http://localhost:3333/viewer when the server is active.
