// exp_headsup2: second round of heads-up variants, built around the cap-0.9 adversary. Same wrapper as exp_headsup.ts.
import type { Strategy } from "../core/types.js";
import { createStrategy as createAdversary, type AdvParams } from "./adversary.js";
import { createEconomist } from "./economist.js";
import { makeHx } from "./exp_headsup.js";

const C9: Partial<AdvParams> = { pushCapFrac: 0.9, pushMinFrac: 0.1 };
const v = (name: string, o: Partial<AdvParams>) =>
  [name, () => makeHx({ vick: () => createAdversary({ ...C9, ...o }), fp: () => createEconomist(), dumpAt: 1 }, name)] as const;

export function createStrategy(): Strategy {
  return makeHx({ vick: () => createAdversary(C9), fp: () => createEconomist(), dumpAt: 1 }, "exp_headsup2");
}

export const STRATEGIES: Record<string, () => Strategy> = Object.fromEntries([
  v("hy-c9", {}),
  v("hy-c10", { pushCapFrac: 1.0 }),
  v("hy-c9m05", { pushMinFrac: 0.05 }),
  v("hy-c9m20", { pushMinFrac: 0.2 }),
  v("hy-c9t11", { tmult: 1.1 }),
  v("hy-c9t09", { tmult: 0.9 }),
  v("hy-c9p105", { push: 1.05 }),
  v("hy-c9p095", { push: 0.95 }),
  v("hy-c9u3", { pushUntilBag: 3 }),
  v("hy-c9u10", { pushUntilBag: 10 }),
  v("hy-c9s3", { startRound: 3 }),
  v("hy-c9s10", { startRound: 10 }),
  v("hy-c9deny", { deny: 1.25 }),
  // cap-0.9 Vickrey rule + economist with fpShade0 1.0 in FirstPrice heads-up (candidate; see docs/notes/fleet-headsup.md)
  [
    "hy-full",
    () => makeHx({ vick: () => createAdversary(C9), fp: () => createEconomist({ fpShade0: 1.0 }), dumpAt: 1 }, "hy-full"),
  ] as const,
]);

export default createStrategy;
