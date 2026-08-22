import assert from 'node:assert/strict';
import loader from 'blind-loader';

assert.equal(loader.loadHidden(), 'hidden-cjs:pong');
assert.equal(await loader.loadEsm(), 'hidden-esm:pong');
assert.equal(loader.loadAsset(), 'carrier-data-42');
console.log('fixture-nft-blind: ok');
