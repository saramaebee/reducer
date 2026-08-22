import assert from 'node:assert/strict';
import { hi } from 'prodlib';

assert.equal(hi(), 'prodlib:hi');
// devonly is outside the production universe (lockfile dev:true, untraced):
await assert.rejects(() => import('devonly'), /Cannot find/);
console.log('fixture-dev-boundary: ok');
