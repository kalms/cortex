---
name: explain-architecture
description: Explain why a code area was built the way it was by combining decision history, call chains, and code structure. Use when someone asks "why does this work this way?" or "what's the architecture of this area?"
---

# Explain Architecture

Provide a narrative explanation of a code area by combining decision history, call chains, and structural context from the Cortex knowledge graph.

## Step 1: Find governing decisions

```
decision({ action: "why", qualified_name: "<qualified name or file path>" })
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

## Step 5: Spotlight while you explain

Optional — when a live viewer is reachable and a visual pointer would help,
hold a spotlight on each synthesis section as you present it:

```
show({ action: "focus", repo_path, refs: ["<section files>", "<D-decision-ids>"], note: "<section headline>" })
```

Post one `focus` call per section — its files together with any decision ids
that govern them — with a short `note` naming the section, so the caption
card advances in step with the narration. Clear the spotlight when you're
done:

```
show({ action: "focus", repo_path, refs: [] })
```

Degrade gracefully: `show` never throws for an unreachable viewer, and the
prose explanation must stand on its own whether or not anyone is watching
it. Treat this step as discretionary, never as ceremony — skip it for a
quick, single-file answer or when a viewer is unlikely to be open. See the
[`show-your-work`](../show-your-work/SKILL.md) skill for the full contract.

### Always finish by emitting the story

In addition to any live spotlighting above, **always** close out the
explanation by persisting it as a story — one step per synthesis section,
so the user (or a later session) can page back through the explanation on
the graph:

```
show({ action: "story", repo_path, title: "<area> — architecture", closed: true, steps: [
  { caption: "<1–2 sentence distillation of this section>", refs: ["<section files/qns>", "<D-decision-ids>"] },
  …one step per section…
] })
  → { story_id, step_count, viewer_url }
```

- **One step per section** from Step 4's synthesis, in the same order —
  reuse each section's refs (files, qualified names, governing decision
  ids) verbatim.
- **Caption = a 1–2 sentence distillation**, not the full prose — the
  caption card is a pointer back into the explanation, not a replacement
  for it.
- **Always `closed: true`.** This narration was never live — it must not
  receive a stray `advance`, and it should only ever surface via its link
  or the story palette, not as something mid-playback.
- **No viewer-liveness probe.** Unlike `focus`, don't check whether a
  viewer is reachable first — `story` persists regardless, and the
  `viewer_url` it returns works whenever a viewer is next opened.
- **Hand back the `viewer_url`** in your final message alongside the prose
  explanation. The prose must stay fully self-sufficient on its own — the
  story is a bonus artifact, never a substitute for the written answer.
