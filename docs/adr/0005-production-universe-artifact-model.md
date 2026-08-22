# The artifact is the production universe minus proofs, not the NFT trace

The emitted deployment tree is `production universe − proven-unreachable`,
where the production universe is the complete production application
filesystem (app files plus every installed package the lockfile does not mark
`dev: true`). `@vercel/nft` supplies *positive* reachability evidence only —
seeding definitely-reachable files, diagnostics, and baseline metrics. The
invariant, mirrored in code and regression tests:

```
nftTrace.has(file) === false   does NOT imply   fileState === "proven-unreachable"
```

NFT omission never authorizes deletion. NFT warnings and missing edges widen
retention; they never narrow the output.

We adopted this after the Torture Garden proved the previous model unsound at
file level: the tree used to be exactly the NFT trace, so everything NFT
cannot see — `createRequire` targets, reconstructed/eval'd requires,
non-literal `import()`, VM-loaded modules, emscripten's computed-fs-path
`sql-wasm.wasm`, package-scoped dynamic requires — was physically absent, and
the reduced service diverged on 13 contracts and crashed on the WASM path
while the *symbol* analyzer was reporting "retain everything". The retention
layer followed the proof discipline; the build layer did not. Making the
build follow the same discipline (KEEP / UNKNOWN / POSSIBLY-REACHABLE → the
file ships; only PROVEN-UNREACHABLE may be removed) restores the base
property that a zero-transformation build is behaviorally identical to the
original under stock Node.

The costs are deliberate. The artifact is larger than an NFT-derived tree —
soundness outranks size, and a zero-reduction sound artifact beats an unsound
smaller one. The only up-front exclusion is the lockfile `dev: true`
boundary, because it reproduces a standard production install
(`npm ci --omit=dev`); even that yields to positive evidence — an NFT-traced
"dev" package is retained in full with a warning. File-level *removal* stays
off the table until an explicit per-file proof mechanism exists, and every
emitted or removed file carries provenance in the manifest (`artifact.files`
/ `artifact.removed`) so "why does this file exist?" and "what proof
authorized this removal?" are always answerable.
