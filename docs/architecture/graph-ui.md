# Graph UI Architecture

> Living document. Started 2026-04-17. Updated as the system is built.

## System overview

Cortex emits structured events for decision lifecycle and git activity, persists them to an append-only SQLite log, derives graph mutations from those events, and broadcasts both over a WebSocket. A 2D graph viewer and an activity stream consume the broadcasts in tandem.

## Thread model

(Diagram inserted in Task 16 — see spec section "Architecture" for current draft.)

## Event flow: "Claude creates a decision"

(Walkthrough inserted in Task 16.)

## Component boundaries

(Filled in Task 16 as each component is built.)

## Design rationale

See [the spec](../superpowers/specs/2026-04-17-graph-ui-and-activity-stream-design.md#why-two-threads). Summarized here in Task 16.

## Extending the system

(Filled in Task 16 with concrete recipes for common extensions.)

## Deferred / future work

- Multi-user / collaboration
- Gap detection
- Temporal slider
- External event bus (Redis/Kafka/NATS)
- Louvain clustering
- VS Code sidebar
- Phone PWA

See spec "Future extensibility" for prep hooks already in place.

## Testing strategy

See spec section "Testing strategy".
