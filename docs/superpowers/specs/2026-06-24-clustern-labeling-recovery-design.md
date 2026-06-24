# Design — `cluster:N` labeling recovery (Pass 4.5 + directory-aware char rule + honest fallback)

**Date:** 2026-06-24
**Author:** Claude (Opus 4.8, 1M context) + rka
**Branch:** `feature/frames/clustern-labeling`
**Targets:** the opaque `cluster:N` frame labels in Cortex (and any repo) — the original complaint. Builds on decision **D-0j21** ("`cluster:N` is a labeling problem").

---

## Problem

Cortex shows ~5 opaque `cluster:N` frame labels. [`pickFrameLabel`](../../../src/frame-extraction/inject-frames.ts) emits `cluster:N` only when its 4 passes (eligible n-gram → eligible unigram → common path prefix → dominant path segment) all fail. An audit of Cortex's actual `cluster:N` clusters shows they fall into two modes:

**Mode A — a real name is present but killed by the gate's strictness:**
- `cluster:2` → **ws** (`src/ws/*` + `tests/ws/*`): filtered only because `ws` is ≤2 chars (`isGenericToken` length rule).
- `cluster:6` → **ids / allocator** (`src/ids/*`, `tests/ids/*`): `ids` ∈ `GENERIC_TOKENS`; `allocator` just missed the 50% salience gate.
- `cluster:5` → **index-meta** (`graph/capture-index-meta`, `graph/index-meta`): top tokens `index`, `meta` both ∈ `GENERIC_TOKENS`.

**Mode B — genuinely mixed blobs, no token at 50% salience:**
- `cluster:11` (14 files, decisions/todos/api repositories + tests): `repository`/`store`/`todos` each ~30–43%.
- `cluster:15` (9 files, decisions/prs/todos `service.ts` + `events/bus`): `service`/`events`/`bus` ~33%.

## Root cause

The eligibility gate (`isLabelEligibleWord` + `isGenericToken`) is tuned for *precision* in the normal passes, which is correct there — but there is no *recall* safety net before `cluster:N`. Three filters over-reject at the margin: the blanket ≤2-char rule, `GENERIC_TOKENS` membership, and the hard 50% salience floor.

## Design

Three changes, scoped by blast radius:

### 1. Directory-aware char rule — GLOBAL (all passes)

The ≤2-char rule in `isGenericToken` blanket-rejects `ws`, `io`, `db`, `ui`. Make it **directory-aware**: a ≤2-char token is NOT generic-by-length when it appears as an actual **directory segment** in the member paths (a real subsystem folder), but still generic when it only appears as a filename stem/extension (`ts`, `js`). Applied globally because a salient short *directory* is a legitimately good label in any pass, not merely a fallback. `GENERIC_TOKENS` set membership is unchanged here (still rejects `id`, `index`, etc. in the normal passes).

Because this is the one change that can affect *currently-labeled* clusters, the corpus eval is the regression gate (see Validation).

### 2. Pass 4.5 — relaxed last-resort recovery (before `cluster:N`)

Reached only when passes 1–4 fail, so it cannot displace any existing good label. Try, in order:
1. The top-ranked **non-generic** salient token (any length if directory-backed).
2. The top-ranked **generic-but-real** token that is salient (recovers `index-meta`, `ids`) — generic tokens are *allowed here as last resort*, deprioritized below non-generic.
3. The dominant path segment at a **lowered salience bar (≥0.3)** (recovers Mode B's `repository`, `events`).
4. Always excluded, even here: route-param tokens, bracketed/dynamic segments, repo-ubiquitous suppressed terms — these never make good labels.

Multi-word tokens still render via `formatPathOrderedLabel`.

### 3. Honest descriptor fallback — replaces raw `cluster:N`

If even Pass 4.5 finds nothing, emit a human-readable descriptor instead of `cluster:N`: the dominant top-level directory(ies) of the members + file count (e.g. `decisions/todos · 14 files`). Deterministic. Expected to fire rarely after Pass 4.5.

## Determinism

All additions are sorted string/salience operations over the same inputs — no randomness. Same input → same label.

## Components

- `src/frame-extraction/inject-frames.ts`:
  - `isGenericToken` / a new helper: directory-aware short-token check (needs member paths — thread them in, or compute a "directory segment set" once in `pickFrameLabel`).
  - `pickFrameLabel`: insert Pass 4.5 between the dominant-segment pass and the `cluster:N` return; add the descriptor fallback as the final branch.
  - Likely a small `dominantPathSegmentLabel` variant or param for the lowered salience bar.
- Tests: `tests/frame-extraction/inject-frames.test.ts` — extend with the audited real cases (ws, ids/allocator, index-meta, the two Mode-B blobs) plus the directory-vs-stem distinction for short tokens, and a genuinely-unnameable case that still hits the descriptor fallback.

## Validation

- **Direct target:** re-cluster Cortex; `cluster:N` count should drop from 5 to ~0–1, replaced by `ws`, `ids`/`allocator`, `index-meta`, `repository`, `events` (or the descriptor).
- **Regression guard (for the global char change):** run the corpus eval (`label-quality.ts` F1 + `clusters_below_f1`); the global directory-aware char rule must not *lower* label-F1 or raise clusters-below-floor on the corpus. If it does, narrow it to last-resort-only.
- Determinism: re-run → identical labels.

## Honest scope

Unlike the hierarchy signal, this **directly** addresses the original complaint: it targets the `cluster:N` labels in Cortex (a functional repo) and any repo. Expected outcome: Cortex's opaque labels go from ~5 to ~0–1, the rest becoming real (if sometimes imperfect) names — the explicit premise being that a real-but-imperfect name beats an opaque `cluster:N`.
