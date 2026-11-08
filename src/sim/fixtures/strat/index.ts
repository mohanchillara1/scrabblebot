// Fixture: index.ts is never auto-loaded, even if it exports createStrategy.
export function createStrategy() {
  return { name: "index", words: () => [], bid: () => 0 };
}
