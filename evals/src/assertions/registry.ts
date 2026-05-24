import { FIX_2_ASSERTIONS } from "./fix-2-http-calls.js";
import { FIX_3_ASSERTIONS } from "./fix-3-auto-imports.js";
import { FIX_4_ASSERTIONS } from "./fix-4-sfc-functions.js";
import { FIX_5_ASSERTIONS } from "./fix-5-nitro-handlers.js";
import { FIX_6_ASSERTIONS } from "./fix-6-route-poison.js";
import { FIX_8_ASSERTIONS } from "./fix-8-decision-promotion.js";
import type { Assertion } from "./types.js";

export const ALL_ASSERTIONS: Assertion[] = [
  ...FIX_2_ASSERTIONS,
  ...FIX_3_ASSERTIONS,
  ...FIX_4_ASSERTIONS,
  ...FIX_5_ASSERTIONS,
  ...FIX_6_ASSERTIONS,
  ...FIX_8_ASSERTIONS,
];
