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

## Stories

A story is a **durable, ordered walkthrough** — steps the user pages through
in the viewer, either live as you narrate or later on their own. Reach for
one instead of a run of `focus` calls when:

- **A multi-file explanation the user will revisit** — `focus` is live-only
  (never backfilled) and evaporates when the tab closes; a story persists and
  can be reopened via its `viewer_url` or the palette.
- **Pre-refactor blast radius** — a checkpoint the user can page back through
  while they review, not just something that flashed by during the chat.
- **A branch walkthrough** — one step per commit/concern, so the reviewer
  controls the pace instead of following your narration in real time.

For a quick, single-shot pointer during a live explanation, `focus` is still
the right (cheaper, non-durable) tool — see above. Don't reach for a story
for a one-file answer.

### Composition rules

- **3–7 steps.** Fewer reads as not worth a story; more dilutes each step —
  split into a shorter story or trim to the throughline.
- **One idea per step.** Each step is a single checkpoint, not a paragraph
  compressed into a caption.
- **Refs that resolve.** Prefer refs you know are in the current graph
  (paths, `"path::symbol"` qualified names, `D-`/`T-` ids) — an unresolvable
  ref still renders (as a plain mention on the caption card, never an error)
  but it's a weaker step.
- **Captions say *why*, not just what.** "Presence hook posts here" is
  weaker than "Presence hook posts here because it must degrade-safe on a
  dead viewer."

### The contract

```
show({ action: "story", repo_path, title, description?, closed?, steps: [
  { caption, refs, emphasis_edges?, layout_hint? }, …
], links?: { decision_ids?, pr_number? } })
  → { story_id, step_count, viewer_url }
show({ action: "advance", repo_path, story_id, step })   // 1-based; user paging wins — never spam advance
show({ action: "get" | "list" | "close" | "delete", repo_path, story_id? })
```

- `story` is **atomic** — steps are inline in one call; there's no
  incremental step-building, so a half-built story never dangles.
- **Stories persist.** Share the `viewer_url` — it works whenever a viewer
  opens, live or not, this session or a later one.
- **`close` when live narration ends.** A closed story is done being paged
  live but stays listable/openable; use it once you're finished driving
  `advance` for a given walkthrough. (`explain-architecture` creates its
  stories already-closed — see that skill.)
- **`focus` remains the cheap, non-durable spotlight** for everything that
  doesn't need to survive the chat.
- **Presence stays automatic** — neither `focus` nor a story replaces it or
  requires it; they're separate signals.

## Not this skill

- **Automatic presence** — hook-fed, zero agent effort, always on. See
  [show-your-work.md](../../docs/architecture/show-your-work.md).
- **Network layout mode** — future slice (3), not shipped; do not build
  against it.
