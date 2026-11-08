// Strategy registry: name -> factory.
//
// Built in: starter, starter-hold7, value-plus (baselines.ts).
// Auto-loaded: every *.ts file in src/strategies/ and src/models/ (except *.test.ts, *.d.ts, index.ts and files
// starting with "_") that exports
//     createStrategy(seed?: number): Strategy      -> registered under the file name (without .ts), or
//     STRATEGIES: Record<string, () => Strategy>   -> registered under each key.
// A file that fails to import is skipped and listed in `loadErrors` (the CLI prints it); it never aborts the run.

import { existsSync, readdirSync } from "node:fs";
import type { Strategy } from "../core/types.js";
import { BASELINES } from "./baselines.js";

export type StrategyFactory = (seed?: number) => Strategy;
export type StrategySource = "builtin" | "strategies" | "models";

export interface RegistryEntry {
  name: string;
  factory: StrategyFactory;
  source: StrategySource;
  file?: string;
}

export interface Registry {
  entries: Map<string, RegistryEntry>;
  loadErrors: { file: string; error: string }[];
}

export interface ScanDir {
  dir: URL;
  source: StrategySource;
}

const SCAN: ScanDir[] = [
  { dir: new URL("../strategies/", import.meta.url), source: "strategies" },
  { dir: new URL("../models/", import.meta.url), source: "models" },
];

/** `scan` is overridable for tests; the default scans src/strategies and src/models. */
export async function loadRegistry(scan: ScanDir[] = SCAN): Promise<Registry> {
  const entries = new Map<string, RegistryEntry>();
  const loadErrors: { file: string; error: string }[] = [];

  for (const [name, factory] of Object.entries(BASELINES)) {
    entries.set(name, { name, factory, source: "builtin" });
  }

  const add = (e: RegistryEntry) => {
    if (entries.has(e.name)) {
      loadErrors.push({ file: e.file ?? e.name, error: `duplicate strategy name "${e.name}" ignored (first registration wins)` });
      return;
    }
    entries.set(e.name, e);
  };

  for (const { dir, source } of scan) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts") && f !== "index.ts" && !f.startsWith("_"))
      .sort();
    for (const f of files) {
      const url = new URL(f, dir);
      try {
        const mod = (await import(url.href)) as Record<string, unknown>;
        const base = f.replace(/\.ts$/, "");
        let found = false;
        if (typeof mod["createStrategy"] === "function") {
          add({ name: base, factory: mod["createStrategy"] as StrategyFactory, source, file: `${source}/${f}` });
          found = true;
        }
        const table = mod["STRATEGIES"];
        if (table && typeof table === "object") {
          for (const [name, factory] of Object.entries(table as Record<string, unknown>)) {
            if (typeof factory === "function") {
              add({ name, factory: factory as StrategyFactory, source, file: `${source}/${f}` });
              found = true;
            }
          }
        }
        void found; // files exporting neither are silently ignored (helpers)
      } catch (e) {
        loadErrors.push({ file: `${source}/${f}`, error: e instanceof Error ? (e.stack ?? e.message).split("\n").slice(0, 3).join(" | ") : String(e) });
      }
    }
  }
  return { entries, loadErrors };
}

/** Instantiate and sanity-check a strategy. Throws a clear error if the factory returns a malformed object. */
export function instantiate(entry: RegistryEntry, seed: number): Strategy {
  const s = entry.factory(seed);
  if (!s || typeof s.words !== "function" || typeof s.bid !== "function") {
    throw new Error(`strategy "${entry.name}" (${entry.file ?? entry.source}) did not return an object with words() and bid()`);
  }
  return s;
}
