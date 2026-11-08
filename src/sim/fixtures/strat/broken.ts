// Fixture: a file whose import fails must be skipped and reported, not abort the registry.
if (Date.now() > 0) throw new Error("fixture import failure");
export function createStrategy() {
  return { name: "broken", words: () => [], bid: () => 0 };
}
