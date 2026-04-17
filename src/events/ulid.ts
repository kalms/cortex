import { monotonicFactory } from 'ulid';

/**
 * Emits a ULID that is strictly monotonic within the same millisecond.
 *
 * Used as the primary key for every event. Sorting by `id` equals sorting by
 * `created_at`, so we avoid an extra indexed timestamp column for the main
 * stream-feed query.
 *
 * Shared factory state is intentional — module-scoped so every caller in the
 * process uses the same clock.
 */
const generate = monotonicFactory();

/**
 * Returns a new ULID string. Monotonic within the same millisecond.
 * See module-level comment on `generate` for rationale.
 */
export function newUlid(): string {
  return generate();
}
