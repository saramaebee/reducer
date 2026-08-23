import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const c = req('chalk');
export function use() { return c; }
