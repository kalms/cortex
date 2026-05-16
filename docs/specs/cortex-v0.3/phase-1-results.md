# Phase 1 — Index-Stats Survey Results

Generated: 2026-05-16T20:40:26.743Z
Corpus size: 8 (8 ok, 0 failed)

## Per-repo stats

| slug | archetype | lang | files | entities | edges | density | max_depth | mean_depth | aux_dirs | secs |
|---|---|---|---:|---:|---:|---:|---:|---:|---|---:|
| `self/cortex` | ts-monorepo | typescript | 985 | 9879 | 46381 | 2.769 | 7 | 4.08 | internal, tests | 0.5 |
| `vueuse/vueuse` | vue-library | typescript | 1545 | 2441 | 12977 | 1.448 | 6 | 2.96 | packages, test | 2.2 |
| `TanStack/table` | react-library | typescript | 3959 | 3701 | 35003 | 1.713 | 7 | 3.95 | examples, packages | 3.9 |
| `trpc/trpc` | ts-monorepo | typescript | 1574 | 3702 | 17916 | 1.668 | 8 | 3.76 | examples, packages, www | 2.7 |
| `nuxt/ui` | nuxt-app | typescript | 2104 | 1667 | 15766 | 1.346 | 6 | 3.75 | docs, playgrounds, test | 4.2 |
| `spf13/cobra` | go-cli | go | 66 | 621 | 4437 | 4.588 | 3 | 0.82 | assets | 0.9 |
| `pallets/click` | python-library | python | 149 | 1222 | 7862 | 3.888 | 4 | 1.50 | — | 1.0 |
| `huggingface/peft` | python-ml | python | 773 | 3601 | 38469 | 3.005 | 5 | 2.91 | — | 2.8 |

## Distribution

### entity_count
- min: 621
- p25: 1222
- median: 2441
- p75: 3701
- max: 9879

### edge_density
- min: 1.346
- p25: 1.448
- median: 1.713
- p75: 3.005
- max: 4.588

## Suggested threshold

Starter target from the spec: `entity_count > 300 OR edge_density > 0.05`. p25 of the surveyed corpus is **entity_count=1222**, **edge_density=1.448** — repos below the p25 are the calibration floor for "low complexity" (step-3 ACDC refinement skips). Tune downstream by checking how Phase-2 outputs degrade as the threshold shifts.
