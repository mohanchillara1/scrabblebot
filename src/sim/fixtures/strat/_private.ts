// Fixture: files starting with "_" are never auto-loaded.
export function createStrategy() {
  return { name: "_private", words: () => [], bid: () => 0 };
}
