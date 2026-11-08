// Fixture for the registry auto-load test: registered under the file name "alpha".
import type { Strategy } from "../../../core/types.js";
export function createStrategy(): Strategy {
  return { name: "alpha", words: () => [], bid: () => 1 };
}
