import { FIX_2_ASSERTIONS } from "./fix-2-http-calls.js";
import { FIX_3_ASSERTIONS } from "./fix-3-auto-imports.js";
import { FIX_4_ASSERTIONS } from "./fix-4-sfc-functions.js";
import { FIX_5_ASSERTIONS } from "./fix-5-nitro-handlers.js";
import { FIX_6_ASSERTIONS } from "./fix-6-route-poison.js";
import { FIX_8_ASSERTIONS } from "./fix-8-decision-promotion.js";
import { UNIVERSAL_ASSERTIONS } from "./universal.js";
import type { Assertion, AssertionScope } from "./types.js";

export const ALL_ASSERTIONS: Assertion[] = [
  ...FIX_2_ASSERTIONS,
  ...FIX_3_ASSERTIONS,
  ...FIX_4_ASSERTIONS,
  ...FIX_5_ASSERTIONS,
  ...FIX_6_ASSERTIONS,
  ...FIX_8_ASSERTIONS,
  ...UNIVERSAL_ASSERTIONS,
];

/** Filter assertions to those whose scope is in the target's packs.
 *  Order follows ALL_ASSERTIONS so report output stays stable. */
export function selectAssertions(
  all: Assertion[],
  packs: AssertionScope[],
): Assertion[] {
  const wanted = new Set(packs);
  return all.filter((a) => wanted.has(a.scope));
}
