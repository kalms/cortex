---
name: explain-architecture
description: Explain why a code area was built the way it was by combining decision history, call chains, and code structure. Use when someone asks "why does this work this way?" or "what's the architecture of this area?"
---

# Explain Architecture

Provide a narrative explanation of a code area by combining decision history, call chains, and structural context from the Cortex knowledge graph.

## Step 1: Find governing decisions

```
why_was_this_built({ qualified_name: "<qualified name or file path>" })
```

This walks up the file hierarchy to find decisions that GOVERNS the code entity or its parent paths.

## Step 2: Trace the call chain

```
trace_path({ function_name: "<function name>", mode: "calls" })
trace_path({ function_name: "<function name>", mode: "callers" })
```

This shows what the function calls (downstream) and what calls it (upstream).

## Step 3: Get structural context

```
search_graph({ qn_pattern: "src/path/to/module%" })
```

This shows all code entities in the module — functions, classes, imports.

## Step 4: Synthesize

Combine the results into a narrative:

1. **What it does** — from the code structure and call chains
2. **Why it was built this way** — from the governing decisions and their rationale
3. **What alternatives were considered** — from the decision records
4. **What it depends on / what depends on it** — from the call chain

Present this as a coherent explanation, not raw tool output.
