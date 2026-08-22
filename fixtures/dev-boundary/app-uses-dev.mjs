// Positive-evidence widening case: the lockfile marks devonly dev-only, but
// this entry actually imports it — NFT's trace must un-exclude the package.
import { tool } from 'devonly';
console.log(tool());
