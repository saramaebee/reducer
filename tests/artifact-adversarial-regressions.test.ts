import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run } from '@reducer/cli';

/**
 * Regression tests for the defects confirmed by the adversarial review of the
 * production-universe artifact builder (one test per confirmed finding).
 */

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

const fixture = () => mkdtempSync(path.join(tmpdir(), 'reducer-adv-'));

async function build(root: string) {
  const outDir = mkdtempSync(path.join(tmpdir(), 'reducer-adv-out-'));
  const result = await run({ entry: path.join(root, 'app.mjs'), outDir, write: true });
  return { ...result, outDir };
}

test('F1: symlinked .node keeps the package opaque (native-boundary, no removal)', async () => {
  const root = fixture();
  writeTree(root, {
    'package.json': '{ "name": "t-natpkg", "version": "1.0.0" }',
    'app.mjs': "import { used } from 'natpkg';\nconsole.log(used());\n",
    'node_modules/natpkg/package.json': '{ "name": "natpkg", "version": "1.0.0", "main": "index.js" }',
    'node_modules/natpkg/index.js':
      "require('./binding.node');\n" +
      "function used() { return 'natpkg:used'; }\n" +
      "function unused() { return 'natpkg:unused'; }\n" +
      'exports.used = used;\nexports.unused = unused;\n',
    'node_modules/.prebuilds/real.node': 'not-a-real-addon-but-traced-as-one',
  });
  // The boundary file reaches the package ONLY through a symlink: dirent-type
  // checks see a symlink, trace-kind checks see extension .node.
  symlinkSync('../.prebuilds/real.node', path.join(root, 'node_modules/natpkg/binding.node'));

  const { manifest } = await build(root);
  expect(manifest.metrics.analyzer.globalHazards).toEqual([]);
  const unused = manifest.verdicts.find((v) => v.symbol === 'unused' && v.pkg?.startsWith('natpkg@'));
  expect(unused?.state).toBe('unknown');
  expect(unused?.reasons).toEqual(['native-boundary']);
  expect(manifest.transformations).toHaveLength(0);
});

test('F2: dev:true lockfile keys outside node_modules never exclude source dirs', async () => {
  const root = fixture();
  writeTree(root, {
    'package.json': '{ "name": "t-srcdev", "version": "1.0.0", "devDependencies": { "gen": "file:tools/gen" } }',
    'package-lock.json': JSON.stringify({
      name: 't-srcdev',
      lockfileVersion: 3,
      packages: {
        '': { name: 't-srcdev', version: '1.0.0', devDependencies: { gen: 'file:tools/gen' } },
        'tools/gen': { version: '1.0.0', dev: true },
        'node_modules/gen': { resolved: 'tools/gen', link: true },
      },
    }),
    'app.mjs': "console.log('hi');\n",
    'tools/gen/package.json': '{ "name": "gen", "version": "1.0.0" }',
    'tools/gen/data.txt': 'gen-data\n',
  });
  mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  symlinkSync('../tools/gen', path.join(root, 'node_modules/gen'));

  const { manifest, outDir } = await build(root);
  // npm ci --omit=dev prunes node_modules only; a source dir is never deletable.
  expect(existsSync(path.join(outDir, 'tools/gen/data.txt'))).toBe(true);
  expect(manifest.artifact.devExcludedPackages).toEqual([]);
});

test('F3: transformation is reverted when the removed body ships in a sibling copy', async () => {
  const vulnFn = "function unusedVuln() {\n  return 'VULN_MARKER_BODY_XYZ';\n}";
  const root = fixture();
  writeTree(root, {
    'package.json': '{ "name": "t-dup", "version": "1.0.0" }',
    'app.mjs': "import { used } from 'duppkg';\nconsole.log(used());\n",
    'node_modules/duppkg/package.json': '{ "name": "duppkg", "version": "1.0.0", "main": "lib/index.js" }',
    'node_modules/duppkg/lib/index.js':
      `function used() { return 'ok'; }\n${vulnFn}\n` + 'exports.used = used;\nexports.unusedVuln = unusedVuln;\n',
    // Untraced dual-build copy with the identical implementation.
    'node_modules/duppkg/esm/index.mjs': `${vulnFn}\nexport { unusedVuln };\n`,
  });

  const { manifest, outDir } = await build(root);
  expect(manifest.metrics.analyzer.globalHazards).toEqual([]);
  // Stubbing one copy while the other ships would make physical-absence false:
  expect(manifest.transformations).toHaveLength(0);
  expect(manifest.warnings.join('\n')).toContain('REVERTED');
  const lib = readFileSync(path.join(outDir, 'node_modules/duppkg/lib/index.js'), 'utf8');
  expect(lib).toContain('VULN_MARKER_BODY_XYZ'); // retained, not stubbed
  expect(lib).not.toContain('ReducerReachabilityViolation');
});

test('F4a: a nonstandard-named original map retaining the removed body is suppressed', async () => {
  const root = fixture();
  const source =
    "function used() { return 'ok'; }\n" +
    "function unused() { return 'MAP_LEAK_MARKER_1'; }\n" +
    'exports.used = used;\nexports.unused = unused;\n' +
    '//# sourceMappingURL=custom.map\n';
  writeTree(root, {
    'package.json': '{ "name": "t-map", "version": "1.0.0" }',
    'app.mjs': "import { used } from 'maplib';\nconsole.log(used());\n",
    'node_modules/maplib/package.json': '{ "name": "maplib", "version": "1.0.0", "main": "index.js" }',
    'node_modules/maplib/index.js': source,
    'node_modules/maplib/custom.map': JSON.stringify({
      version: 3,
      sources: ['index.js'],
      sourcesContent: [source],
      mappings: 'AAAA',
    }),
  });

  const { manifest, outDir } = await build(root);
  expect(manifest.transformations.map((t) => t.symbol)).toEqual(['unused']);
  // The pre-existing map embedded the removed body in sourcesContent:
  expect(existsSync(path.join(outDir, 'node_modules/maplib/custom.map'))).toBe(false);
  expect(manifest.warnings.join('\n')).toContain('custom.map');
  const emitted = readFileSync(path.join(outDir, 'node_modules/maplib/index.js'), 'utf8');
  // The stale original sourceMappingURL comment is stripped; only ours remains.
  expect(emitted.match(/sourceMappingURL/g)).toHaveLength(1);
  expect(emitted).toContain('sourceMappingURL=index.js.map');
  const map = readFileSync(path.join(outDir, 'node_modules/maplib/index.js.map'), 'utf8');
  expect(map).not.toContain('MAP_LEAK_MARKER_1');
});

test('F4b: an inline data-URI source map cannot carry the removed body through', async () => {
  const root = fixture();
  const body = "function unused() { return 'INLINE_LEAK_MARKER_2'; }";
  const inline = Buffer.from(
    JSON.stringify({ version: 3, sources: ['index.js'], sourcesContent: [body], mappings: 'AAAA' }),
  ).toString('base64');
  writeTree(root, {
    'package.json': '{ "name": "t-inline", "version": "1.0.0" }',
    'app.mjs': "import { used } from 'inlinelib';\nconsole.log(used());\n",
    'node_modules/inlinelib/package.json': '{ "name": "inlinelib", "version": "1.0.0", "main": "index.js" }',
    'node_modules/inlinelib/index.js':
      `function used() { return 'ok'; }\n${body}\n` +
      'exports.used = used;\nexports.unused = unused;\n' +
      `//# sourceMappingURL=data:application/json;base64,${inline}\n`,
  });

  const { manifest, outDir } = await build(root);
  expect(manifest.transformations.map((t) => t.symbol)).toEqual(['unused']);
  const emitted = readFileSync(path.join(outDir, 'node_modules/inlinelib/index.js'), 'utf8');
  expect(emitted).not.toContain('sourceMappingURL=data:');
  expect(emitted).not.toContain(inline);
  expect(emitted).not.toContain('INLINE_LEAK_MARKER_2');
});

test('F5: a stale lockfile dev flag on a declared production dependency excludes nothing', async () => {
  const root = fixture();
  writeTree(root, {
    'package.json': '{ "name": "t-stale", "version": "1.0.0", "dependencies": { "wasneeded": "1.0.0" } }',
    'package-lock.json': JSON.stringify({
      name: 't-stale',
      lockfileVersion: 3,
      packages: {
        '': { name: 't-stale', version: '1.0.0', dependencies: { wasneeded: '1.0.0' } },
        'node_modules/wasneeded': { version: '1.0.0', dev: true }, // stale
      },
    }),
    'app.mjs': "console.log('hi');\n", // loads wasneeded only via runtime-computed specifiers
    'node_modules/wasneeded/package.json': '{ "name": "wasneeded", "version": "1.0.0", "main": "index.js" }',
    'node_modules/wasneeded/index.js': "module.exports.go = () => 'wasneeded:go';\n",
  });

  const { manifest, outDir } = await build(root);
  expect(existsSync(path.join(outDir, 'node_modules/wasneeded/index.js'))).toBe(true);
  expect(manifest.artifact.devExcludedPackages).toEqual([]);
  expect(manifest.warnings.join('\n')).toContain('stale');
});

test('F6: empty directories exist in the artifact', async () => {
  const root = fixture();
  writeTree(root, {
    'package.json': '{ "name": "t-empty", "version": "1.0.0" }',
    'app.mjs': "console.log('hi');\n",
  });
  mkdirSync(path.join(root, 'uploads'));

  const { outDir } = await build(root);
  expect(existsSync(path.join(outDir, 'uploads'))).toBe(true);
  expect(statSync(path.join(outDir, 'uploads')).isDirectory()).toBe(true);
});

test('F7: a traced dev-flagged workspace symlink builds and resolves', async () => {
  const root = fixture();
  writeTree(root, {
    'package.json': '{ "name": "t-ws", "version": "1.0.0" }',
    'package-lock.json': JSON.stringify({
      name: 't-ws',
      lockfileVersion: 3,
      packages: {
        '': { name: 't-ws', version: '1.0.0' },
        'node_modules/devlib': { resolved: 'packages/devlib', link: true, dev: true },
      },
    }),
    'app.mjs': "import { tool } from 'devlib';\nconsole.log(tool());\n",
    'packages/devlib/package.json': '{ "name": "devlib", "version": "1.0.0", "type": "module", "main": "index.js" }',
    'packages/devlib/index.js': "export const tool = () => 'devlib:tool';\n",
  });
  mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  symlinkSync('../packages/devlib', path.join(root, 'node_modules/devlib'));

  const { outDir } = await build(root); // must not EEXIST-crash
  expect(lstatSync(path.join(outDir, 'node_modules/devlib')).isSymbolicLink()).toBe(true);
  expect(existsSync(path.join(outDir, 'packages/devlib/index.js'))).toBe(true);
  const r = spawnSync('node', ['app.mjs'], { cwd: outDir, encoding: 'utf8' });
  expect(r.stdout.trim()).toBe('devlib:tool');
  expect(r.status).toBe(0);
});

test('minor: a transformed file keeps its exact permission bits', async () => {
  const root = fixture();
  writeTree(root, {
    'package.json': '{ "name": "t-mode", "version": "1.0.0" }',
    'app.mjs': "import { used } from 'modelib';\nconsole.log(used());\n",
    'node_modules/modelib/package.json': '{ "name": "modelib", "version": "1.0.0", "main": "index.js" }',
    'node_modules/modelib/index.js':
      "function used() { return 'ok'; }\nfunction unused() { return 'dead'; }\n" +
      'exports.used = used;\nexports.unused = unused;\n',
  });
  chmodSync(path.join(root, 'node_modules/modelib/index.js'), 0o775); // group-write survives the umask

  const { manifest, outDir } = await build(root);
  expect(manifest.transformations.map((t) => t.symbol)).toEqual(['unused']);
  expect(statSync(path.join(outDir, 'node_modules/modelib/index.js')).mode & 0o777).toBe(0o775);
});

test('N1: workspace-hoisted dependencies are inside the universe and ship', async () => {
  const root = fixture();
  writeTree(root, {
    'package.json': '{ "name": "t-mono", "version": "1.0.0", "workspaces": ["packages/*"] }',
    'packages/api/package.json': '{ "name": "api", "version": "1.0.0", "type": "module" }',
    'packages/api/app.mjs': "import { hi } from 'hoisted';\nconsole.log(hi());\n",
    'node_modules/hoisted/package.json': '{ "name": "hoisted", "version": "1.0.0", "type": "module", "main": "index.js" }',
    'node_modules/hoisted/index.js': "export const hi = () => 'hoisted-ok';\n",
  });

  const outDir = mkdtempSync(path.join(tmpdir(), 'reducer-adv-out-'));
  await run({ entry: path.join(root, 'packages/api/app.mjs'), outDir, write: true });
  expect(existsSync(path.join(outDir, 'node_modules/hoisted/index.js'))).toBe(true);
  const r = spawnSync('node', ['packages/api/app.mjs'], { cwd: outDir, encoding: 'utf8' });
  expect(r.stdout.trim()).toBe('hoisted-ok');
  expect(r.status).toBe(0);
});

test('N1b: hoisting with no workspace marker refuses to emit instead of shipping a broken tree', async () => {
  const root = fixture();
  writeTree(root, {
    'sub/package.json': '{ "name": "sub", "version": "1.0.0", "type": "module" }',
    'sub/app.mjs': "import { hi } from 'hoisted';\nconsole.log(hi());\n",
    'node_modules/hoisted/package.json': '{ "name": "hoisted", "version": "1.0.0", "type": "module", "main": "index.js" }',
    'node_modules/hoisted/index.js': "export const hi = () => 'hoisted-ok';\n",
  });

  const outDir = mkdtempSync(path.join(tmpdir(), 'reducer-adv-out-'));
  expect(
    run({ entry: path.join(root, 'sub/app.mjs'), outDir, write: true }),
  ).rejects.toThrow(/outside the production universe/);
});

test('N2: an absolute-target symlink is retargeted into the artifact, not the original tree', async () => {
  const root = fixture();
  writeTree(root, {
    'package.json': '{ "name": "t-abs", "version": "1.0.0" }',
    'app.mjs': "import { used } from 'reallib';\nconsole.log(used());\n",
    'node_modules/reallib/package.json': '{ "name": "reallib", "version": "1.0.0", "main": "index.js" }',
    'node_modules/reallib/index.js':
      "function used() { return 'ok'; }\nfunction unused() { return 'ABS_LINK_MARKER'; }\n" +
      'exports.used = used;\nexports.unused = unused;\n',
  });
  // npm-link-style alias with an ABSOLUTE target back into the source tree.
  symlinkSync(
    path.join(root, 'node_modules/reallib/index.js'),
    path.join(root, 'node_modules/reallib-alias.cjs'),
  );

  const { manifest, outDir } = await build(root);
  expect(manifest.transformations.map((t) => t.symbol)).toEqual(['unused']);
  const link = path.join(outDir, 'node_modules/reallib-alias.cjs');
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  // Reading THROUGH the artifact's link must yield the stubbed content, never
  // the original implementation left behind in the source tree.
  const throughLink = readFileSync(link, 'utf8');
  expect(throughLink).toContain('ReducerReachabilityViolation');
  expect(throughLink).not.toContain('ABS_LINK_MARKER');
});

test('N3: a symlink dependency targeting outside the base is materialized into the artifact', async () => {
  const parent = fixture(); // NOT the base — findBase stops at root/package.json
  const root = path.join(parent, 'app');
  writeTree(parent, {
    'extlib-real/package.json': '{ "name": "extlib", "version": "1.0.0", "type": "module", "main": "index.js" }',
    'extlib-real/index.js': "export const hello = () => 'extlib-ok';\n",
    'app/package.json': '{ "name": "t-ext", "version": "1.0.0" }',
    'app/app.mjs': "import { hello } from 'extlib';\nconsole.log(hello());\n",
  });
  mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  symlinkSync('../../extlib-real', path.join(root, 'node_modules/extlib'));

  const { manifest, outDir } = await build(root);
  // The external content is production surface — it must exist in the
  // artifact even though its realpath was never inside the base.
  expect(existsSync(path.join(outDir, 'node_modules/extlib/index.js'))).toBe(true);
  expect(lstatSync(path.join(outDir, 'node_modules/extlib')).isSymbolicLink()).toBe(false);
  expect(manifest.warnings.join('\n')).toContain('materialized');
  const r = spawnSync('node', ['app.mjs'], { cwd: outDir, encoding: 'utf8' });
  expect(r.stdout.trim()).toBe('extlib-ok');
  expect(r.status).toBe(0);
});

test.if(process.platform === 'darwin')(
  'minor: a case-variant --out inside the base neither self-copies nor bricks the build',
  async () => {
    const root = fixture();
    writeTree(root, {
      'package.json': '{ "name": "t-case", "version": "1.0.0" }',
      'app.mjs': "console.log('hi');\n",
    });
    const first = await run({ entry: path.join(root, 'app.mjs'), outDir: path.join(root, 'dist-reduced'), write: true });
    expect(first.outDir).not.toBeNull();
    // Case-insensitive APFS: DIST-REDUCED is the same directory.
    const second = await run({ entry: path.join(root, 'app.mjs'), outDir: path.join(root, 'DIST-REDUCED'), write: true });
    expect(second.manifest.artifact.files.some((f) => f.file.includes('dist-reduced'))).toBe(false);
    expect(existsSync(path.join(root, 'dist-reduced', 'reducer-manifest.json'))).toBe(true);
  },
);
