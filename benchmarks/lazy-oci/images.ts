/**
 * Build one nydus RAFS image per arm from the SAME staging tree, push each data
 * blob to the local OCI registry, and prove every arm's image is
 * content-identical.
 *
 * Arms differ only in the prefetch table compiled into the bootstrap (and the
 * chunk layout nydus derives from it). That is the substrate's own, commodity
 * way of expressing "these files are prioritised" — the same thing eStargz
 * expresses as layer order plus a landmark.
 *
 * Everything happens in ONE container invocation, from a local copy of the
 * staging tree: the tree is bind-mounted over virtiofs, and reading a 250 000
 * file application six times through it costs more than the whole benchmark.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { WORK_ROOT } from './plan.ts';

export const REGISTRY = 'reducer-registry:5000';
export const NET = 'reducer-net';
export const RUNNER_IMAGE = 'reducer-nydus:v1';
const BUILD_ROOT = path.join(WORK_ROOT, 'images');

export interface BuiltImage {
  app: string;
  arm: string;
  repo: string;
  blob: string;
  blobBytes: number;
  bootstrap: string;
  bootstrapBytes: number;
  prefetchFiles: number;
  prefetchBytes: number;
}

const NYDUS_ARGS =
  '--fs-version 6 --compressor zstd --digester sha256 --chunk-size 0x100000 --repeatable';

/**
 * @param arms arm name → ordered universe-relative prefetch paths, or null for
 *        "no prefetch table at all" (B0/B1 share that image).
 */
export function buildAllImages(
  app: string,
  stage: string,
  arms: Record<string, string[] | null>,
): { images: Record<string, BuiltImage>; contentDigest: string } {
  const outDir = path.join(BUILD_ROOT, app);
  for (const arm of Object.keys(arms)) mkdirSync(path.join(outDir, arm), { recursive: true });

  const script: string[] = [
    'set -e',
    // one virtiofs pass, then every build reads from container-local storage
    'mkdir -p /local /blobs',
    'cp -a /src/. /local/',
    `REPO=lazyoci/${app}`,
  ];
  for (const [arm, list] of Object.entries(arms)) {
    script.push(
      `echo "ARM ${arm}"`,
      `rm -rf /blobs/${arm}; mkdir -p /blobs/${arm}`,
      list === null
        ? `nydus-image create --bootstrap /out/${arm}/boot.img --blob-dir /blobs/${arm} ${NYDUS_ARGS} /local`
        : `nydus-image create --bootstrap /out/${arm}/boot.img --blob-dir /blobs/${arm} ${NYDUS_ARGS} --prefetch-policy fs /local < /out/${arm}/prefetch.txt`,
      `BLOB=$(ls /blobs/${arm} | grep -v boot | head -1)`,
      `echo "BLOB.${arm}=$BLOB"`,
      `echo "BLOBBYTES.${arm}=$(stat -c%s /blobs/${arm}/$BLOB)"`,
      `echo "BOOTBYTES.${arm}=$(stat -c%s /out/${arm}/boot.img)"`,
      // The bootstrap is the authority on which blob nydusd will fetch. A
      // per-arm blob directory that still holds a previous build's blob made
      // \`ls | head -1\` report the WRONG digest, so the wrong object was pushed
      // and the trial died on BLOB_UNKNOWN. Assert the two agree.
      `BOOTBLOB=$(nydus-image inspect -R blobs /out/${arm}/boot.img 2>/dev/null | grep -oE '[0-9a-f]{64}' | head -1)`,
      `[ "$BOOTBLOB" = "$BLOB" ] || { echo "BLOBMISMATCH.${arm}: bootstrap=$BOOTBLOB dir=$BLOB"; exit 9; }`,
      `if ! curl -sf -o /dev/null -I http://${REGISTRY}/v2/$REPO/blobs/sha256:$BLOB; then`,
      `  LOC=$(curl -s -X POST -D- -o /dev/null http://${REGISTRY}/v2/$REPO/blobs/uploads/ | grep -i '^location:' | tr -d '\\r' | awk '{print $2}')`,
      `  curl -s -X PUT "\${LOC}&digest=sha256:$BLOB" -H "Content-Type: application/octet-stream" --data-binary @/blobs/${arm}/$BLOB -o /dev/null -w "PUSH.${arm}=%{http_code}\\n"`,
      `else echo "PUSH.${arm}=cached"; fi`,
      // content-identity proof: mount this arm's image over its own local blob
      // (no registry, no shaping) and hash every file, symlink and mode.
      `mkdir -p /mnt/${arm} /cache/${arm}`,
      `cat > /cfg.${arm}.json <<EOF
{"device":{"backend":{"type":"localfs","config":{"dir":"/blobs/${arm}"}},"cache":{"type":"blobcache","config":{"work_dir":"/cache/${arm}"}}},"mode":"direct","digest_validate":false}
EOF`,
      `nydusd --config /cfg.${arm}.json --mountpoint /mnt/${arm} --bootstrap /out/${arm}/boot.img --apisock /api.${arm}.sock --log-level error &`,
      `for i in $(seq 1 4000); do mountpoint -q /mnt/${arm} && break; sleep 0.01; done`,
      `sleep 1`,
      `( cd /mnt/${arm} && { find . -type l -printf '%p -> %l\\n' | sort; find . -type f -printf '%p\\t%s\\t%m\\n' | sort; find . -type f -print0 | sort -z | xargs -0 -r -n 128 sha256sum | sort -k2; } | sha256sum | cut -d' ' -f1 | sed "s/^/DIGEST.${arm}=/" )`,
      `umount /mnt/${arm} 2>/dev/null || true`,
    );
  }

  const out = execFileSync(
    'docker',
    [
      'run', '--rm', '--platform', 'linux/arm64', '--privileged', '--network', NET,
      '-v', `${stage}:/src:ro`,
      '-v', `${outDir}:/out`,
      RUNNER_IMAGE, 'bash', '-c', script.join('\n'),
    ],
    { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 7_200_000 },
  );

  const grab = (k: string) => {
    const m = new RegExp(`^${k.replace(/[.$]/g, '\\$&')}=(.*)$`, 'm').exec(out);
    if (!m) throw new Error(`nydus build output missing ${k}:\n${out.slice(-3000)}`);
    return m[1]!.trim();
  };
  const images: Record<string, BuiltImage> = {};
  const digests: Record<string, string> = {};
  for (const [arm, list] of Object.entries(arms)) {
    const push = grab(`PUSH.${arm}`);
    if (push !== '201' && push !== 'cached') throw new Error(`blob push failed (${push}) for ${app}/${arm}`);
    images[arm] = {
      app,
      arm,
      repo: `lazyoci/${app}`,
      blob: grab(`BLOB.${arm}`),
      blobBytes: Number(grab(`BLOBBYTES.${arm}`)),
      bootstrap: path.join(outDir, arm, 'boot.img'),
      bootstrapBytes: Number(grab(`BOOTBYTES.${arm}`)),
      prefetchFiles: list?.length ?? 0,
      prefetchBytes: 0,
    };
    digests[arm] = grab(`DIGEST.${arm}`);
  }
  const distinct = new Set(Object.values(digests));
  if (distinct.size !== 1) throw new Error(`[${app}] arms are NOT content-identical: ${JSON.stringify(digests)}`);
  return { images, contentDigest: [...distinct][0]! };
}
