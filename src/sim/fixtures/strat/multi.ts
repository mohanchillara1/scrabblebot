// Fixture: a STRATEGIES table registers each key.
import type { Strategy } from "../../../core/types.js";
const mk = (n: string, b: number) => (): Strategy => ({ name: n, words: () => [], bid: () => b });
export const STRATEGIES: Record<string, () => Strategy> = { "multi-a": mk("multi-a", 2), "multi-b": mk("multi-b", 3) };
