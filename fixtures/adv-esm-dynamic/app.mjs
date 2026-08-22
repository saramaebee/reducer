// Literal dynamic import: the analyzer cannot know which properties of the
// namespace object are used at runtime, so the whole target must be retained.
// (Note: top-level `await import(...)` trips NFT's script-parse fallback and
// widens via nft-warning instead; inside an async function the analyzer's
// dynamic-import retention rule is what fires.)
export async function run() {
  const lib = await import('dynlib');
  return lib.used();
}
