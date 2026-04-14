---
name: search-decisions
description: Search the Cortex knowledge graph for architectural and design decisions. Use when exploring why code was built a certain way, before making architectural changes, or before creating a new decision.
---

# Search Decisions

Search the Cortex knowledge graph for existing architectural and design decisions.

## When to use

- Before creating a new decision — check if one already exists
- When trying to understand why code was built a certain way
- When evaluating whether to change an architectural pattern

## Search by keyword

```
search_decisions({ query: "authentication middleware" })
```

## Scope to specific code

```
search_decisions({ query: "caching", scope: "src/api/routes" })
```

## Find decisions for a code entity

```
why_was_this_built({ qualified_name: "src/auth/middleware.ts::validateToken" })
```

`why_was_this_built` walks up the file hierarchy if no direct match is found — checking the file, then parent directories.

## Get full decision details

```
get_decision({ id: "<decision-id>" })
```

Returns the decision with resolved GOVERNS and REFERENCES links.

## Tips

- Use domain-specific keywords, not generic terms
- Scope narrows results to decisions that GOVERNS a specific code path
- Check search results before creating duplicates
