import { used } from 'innocentlib';
import { evalAdd } from 'hazardlib';
import { Worker } from 'node:worker_threads';

export function main() {
  return used('reduce') + ':' + evalAdd(2, 3);
}

export function runWorker(n) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./node_modules/workerlib/worker.js', import.meta.url));
    w.once('message', (m) => {
      resolve(m);
      w.terminate();
    });
    w.once('error', reject);
    w.postMessage(n);
  });
}
