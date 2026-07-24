---
name: show-your-work
description: Spotlight code, decisions, and todos on the live viewer while explaining or before risky changes. Use when walking through multi-file areas, previewing pre-refactor blast radius, or narrating a review — discretionary, for the user's benefit, never ceremony.
---

# Show Your Work

Hold a spotlight on the refs you're talking about in the live Frames viewer,
using the `show` tool's `focus` action, while explaining code or previewing
a change.

## When to use

- Explaining a multi-file area — spotlight the pieces as you walk through them
- Previewing the blast radius of a risky change before making it
- Narrating a review walkthrough

This is **discretionary** — for the user's benefit when a visual pointer
helps them follow along, never ceremony. Skip it for a quick one-file answer
or when no viewer is likely running.

Live ambient **presence** (avatar motion, frame heat streamed from your
`Read`/`Edit`/`Write` calls) is automatic and separate — it needs no `show`
call, and calling `show` neither replaces it nor requires it.

## The contract

```
show({ action: "focus", repo_path, refs: ["<path>", "<path>::<symbol>", "D-xxxx", "T-xxxx"], note: "<short headline>" })
```

- `refs` — up to 50: repo-relative paths, `"path::symbol"` qualified names
  (the path prefix resolves to a frame), or `D-`/`T-` decision/todo ids
  (matched verbatim). Omitted or `[]` clears the spotlight.
- `note` — up to 2000 chars, a short headline shown on the viewer's caption
  card.
- **Held, not timed.** The spotlight stays exactly as set until you replace
  it, clear it, the user presses Esc, or a project switch/resync wipes it —
  there's no decay to race against.
- **Clear when you're done.** `show({ action: "focus", repo_path, refs: [] })`
  at the end of a walkthrough, so the viewer doesn't keep pointing at stale
  refs.
- **Degrades silently.** `show` never throws for an unreachable viewer — a
  spotlight call is a bonus, not a dependency. Keep your explanation
  self-sufficient in prose regardless of whether a viewer is open.

## Example: multi-file walkthrough

```
show({ action: "focus", repo_path, refs: ["src/events/worker.ts", "src/events/worker/persister.ts"], note: "Event bus: worker + persister" })
# ...explain the pipeline...

show({ action: "focus", repo_path, refs: ["src/mcp-server/api.ts", "D-zwrt"], note: "HTTP entry + the decision that shaped it" })
# ...explain the transport...

show({ action: "focus", repo_path, refs: [] })   # done — clear the spotlight
```

## Not this skill

- **Automatic presence** — hook-fed, zero agent effort, always on. See
  [show-your-work.md](../../docs/architecture/show-your-work.md).
- **Agent-curated stories, deep-linking, network layout** — future slices,
  not shipped; do not build against them.
