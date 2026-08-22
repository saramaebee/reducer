import assert from 'node:assert/strict';
import { main, runWorker } from './app.mjs';
import { unusedHelper } from './node_modules/innocentlib/index.js';
import workermod from './node_modules/workerlib/worker.js';

// App-reachable paths (hazard package's eval actually runs).
assert.equal(main(), 'REDUCE:5');

// Would-be-stubbable export in the innocent package: must still be live.
assert.equal(unusedHelper('abc'), 'cba');

// Worker package exports nobody imports: must still be live.
assert.equal(workermod.unusedWorkerFn(4), 24);
assert.equal(workermod.times7(3), 21);

// Worker actually runs from inside the third-party package.
assert.equal(await runWorker(6), 42);

console.log('fixture-adv-hazard: ok');
