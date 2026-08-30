# Evals

### Adopting improvements

An eval run never rewrites a baseline. When a universal metric improves, the
summary marks it `IMPROVED — baseline stale`; adopt it deliberately with:

    npm run eval -- --target=<name> --accept-improvements

Only metrics the ratchet confirmed as improved are written; regressions and
steady metrics are left untouched. Commit the resulting baseline diff.
