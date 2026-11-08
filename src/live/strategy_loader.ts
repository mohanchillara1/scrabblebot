// Loads src/strategies/<name>.ts (createStrategy), falling back loudly to the
// starter baseline when the import fails.

import type { Strategy } from "../core/types.js";

export interface LoadedStrategy {
  strategy: Strategy;
  requested: string;
  loaded: string;
  fellBack: boolean;
  error?: string;
}

const NAME_RE = /^[A-Za-z0-9_-]+$/;

function pick(mod: Record<string, unknown>, name: string): Strategy | undefined {
  const cs = mod["createStrategy"];
  if (typeof cs === "function") return (cs as (seed?: number) => Strategy)();
  const table = mod["STRATEGIES"];
  if (table && typeof table === "object") {
    const f = (table as Record<string, unknown>)[name];
    if (typeof f === "function") return (f as () => Strategy)();
  }
  const def = mod["default"];
  if (typeof def === "function") return (def as () => Strategy)();
  if (def && typeof def === "object" && typeof (def as Strategy).bid === "function") return def as Strategy;
  return undefined;
}

function valid(s: unknown): s is Strategy {
  const x = s as Strategy | undefined;
  return !!x && typeof x.bid === "function" && typeof x.words === "function";
}

async function loadStarter(): Promise<Strategy> {
  // Prefer src/strategies/starter.ts, then the sim baseline, then an inline last resort.
  try {
    const starterPath = "../strategies/starter.js"; // variable: the file may not exist
    const mod = (await import(starterPath)) as Record<string, unknown>;
    const s = pick(mod, "starter");
    if (valid(s)) return s;
  } catch {
    /* fall through */
  }
  try {
    const mod = (await import("../sim/baselines.js")) as { createStarter?: () => Strategy };
    if (typeof mod.createStarter === "function") {
      const s = mod.createStarter();
      if (valid(s)) return s;
    }
  } catch {
    /* fall through */
  }
  return {
    name: "inline-starter",
    words: () => [],
    bid(view, letter) {
      return Math.max(0, Math.min(view.myBalance, 8 + (view.myRack.get(letter) ?? 0 ? 0 : 2)));
    },
  };
}

export async function loadStrategy(requested: string, quiet = false): Promise<LoadedStrategy> {
  const warn = (s: string) => {
    if (!quiet) console.error(s);
  };
  if (!NAME_RE.test(requested)) {
    warn(`!!!! STRATEGY='${requested}' is not a valid name; falling back to 'starter'`);
    return { strategy: await loadStarter(), requested, loaded: "starter", fellBack: true, error: "invalid name" };
  }
  try {
    const mod = (await import(`../strategies/${requested}.js`)) as Record<string, unknown>;
    const s = pick(mod, requested);
    if (!valid(s)) throw new Error("module has no usable createStrategy()/STRATEGIES/default exporting words() and bid()");
    return { strategy: s, requested, loaded: requested, fellBack: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warn("!".repeat(78));
    warn(`!!!! STRATEGY '${requested}' FAILED TO LOAD: ${msg}`);
    warn(`!!!! FALLING BACK TO THE 'starter' BASELINE. This bot will play WEAKLY until fixed.`);
    warn("!".repeat(78));
    return { strategy: await loadStarter(), requested, loaded: "starter", fellBack: true, error: msg };
  }
}
