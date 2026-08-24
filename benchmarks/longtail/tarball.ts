/**
 * A minimal, deterministic npm tarball, built in code so the fixture data is
 * reproducible rather than an opaque committed blob. Every field that would
 * otherwise vary (mtime, uid, gid) is pinned, and gzip is run at a fixed level
 * with no mtime header, so the same bytes come out on every machine.
 */
import { gzipSync, constants } from 'node:zlib';

function tarHeader(name: string, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 8, 'ascii'); // mode
  h.write('0000000\0', 108, 8, 'ascii'); // uid
  h.write('0000000\0', 116, 8, 'ascii'); // gid
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  h.write('00000000000\0', 136, 12, 'ascii'); // mtime = epoch
  h.write('        ', 148, 8, 'ascii'); // checksum placeholder (spaces)
  h.write('0', 156, 1, 'ascii'); // typeflag: regular file
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

const pad512 = (n: number): number => (n % 512 === 0 ? 0 : 512 - (n % 512));

/** `{ tgz, base64, sha1 }` for a one-file `package/package.json` tarball. */
export function npmTarball(name: string, version: string): { base64: string; length: number } {
  const pj = `${JSON.stringify({ name, version, description: 'long-tail benchmark probe' }, null, 2)}\n`;
  const body = Buffer.from(pj, 'utf8');
  const parts = [tarHeader('package/package.json', body.length), body, Buffer.alloc(pad512(body.length)), Buffer.alloc(1024)];
  const tgz = gzipSync(Buffer.concat(parts), { level: constants.Z_BEST_SPEED });
  return { base64: tgz.toString('base64'), length: tgz.length };
}
