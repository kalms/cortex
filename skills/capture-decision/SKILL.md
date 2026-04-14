---
name: capture-decision
description: Capture an architectural or design decision in the Cortex knowledge graph. Use when you've made or discovered a technology choice, pattern decision, or trade-off that should be recorded.
---

# Capture Decision

Record an architectural or design decision in the Cortex knowledge graph with its rationale, alternatives, and governed code.

## Step 1: Check for duplicates

Before creating, search for existing decisions on the same topic:

```
search_decisions({ query: "<keywords about your decision>" })
```

If a matching decision exists, consider updating it instead of creating a duplicate.

## Step 2: Create the decision

```
create_decision({
  name: "Short descriptive title",
  description: "What was decided and what it means",
  rationale: "Why this approach was chosen over alternatives",
  status: "active",
  alternatives: [
    { name: "Alternative A", reason_rejected: "Why it wasn't chosen" },
    { name: "Alternative B", reason_rejected: "Why it wasn't chosen" }
  ]
})
```

## Step 3: Link to governed code

Connect the decision to the code it governs:

```
link_decision({
  decision_id: "<id from step 2>",
  target: "src/path/to/file.ts::functionOrClassName",
  relation: "GOVERNS"
})
```

You can link multiple code entities. Use `GOVERNS` for code the decision controls, `REFERENCES` for related external resources.

## Step 4: Set the right tier

Decisions start as `personal`. If this is a team-level architectural decision:

```
promote_decision({ id: "<decision-id>", tier: "team" })
```

## What makes a good decision record

- **Name:** Short, scannable — "Use Redis for session caching"
- **Description:** What was decided, not how to implement it
- **Rationale:** The *why* — constraints, trade-offs, context that led to this choice
- **Alternatives:** What was considered and rejected, with reasons
- **Links:** Which code entities this decision governs
