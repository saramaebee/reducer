# ADR-0006 hazard-domain corpus summary

Generated 2026-08-23T19:09:00.362Z. 16 apps loaded (0 failed). 11 target apps, 5 control apps.

**Percentile method:** linear interpolation between order statistics (R type-7 / numpy default / Excel PERCENTILE.INC): idx = p*(n-1), interpolate between floor(idx) and ceil(idx) by the fractional part.

## Strict predicted ceiling — the kill metric

| population | n | median | P25 | P75 | frac >=10% | frac >=15% |
|---|---|---|---|---|---|---|
| TARGET (decision statistic) | 11 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| control (separate, never folded in) | 5 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| full corpus (descriptive) | 16 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |

## Sound-refinement counterfactuals (the only rescue path)

| refinement | population | n | median | P25 | P75 | frac >=10% | frac >=15% |
|---|---|---|---|---|---|---|---|
| SR-vm-known-globals | target | 11 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| SR-vm-known-globals | control | 5 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| SR-vm-known-globals | full | 16 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| SR-subpath-exports-narrowing | target | 11 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| SR-subpath-exports-narrowing | control | 5 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| SR-subpath-exports-narrowing | full | 16 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| SR-import-condition-resolution | target | 11 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| SR-import-condition-resolution | control | 5 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| SR-import-condition-resolution | full | 16 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| SR-cross-module-wrapper | target | 11 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| SR-cross-module-wrapper | control | 5 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| SR-cross-module-wrapper | full | 16 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |

## Single-gate-off headroom — UNSOUND-DIAGNOSTIC upper bound, conditional on all other gates remaining conservative (TARGET apps only)

| gate | apps tested | median delta | mean delta | max delta |
|---|---|---|---|---|
| binding-reassigned | 10 | +0.0 pts | +0.0 pts | +0.0 pts |
| dynamic-property-access | 11 | +0.0 pts | +0.0 pts | +0.0 pts |
| escaped-loader | 11 | +0.0 pts | +0.0 pts | +0.0 pts |
| export-object-mutation | 11 | +0.0 pts | +0.0 pts | +0.0 pts |
| export-star | 10 | +0.0 pts | +0.0 pts | +0.0 pts |
| generated-source-unknown | 11 | +0.0 pts | +0.0 pts | +0.0 pts |
| native-boundary | 9 | +0.0 pts | +0.0 pts | +0.0 pts |
| package-domain-whole | 11 | +0.0 pts | +0.0 pts | +0.0 pts |
| require-cache-mutation | 9 | +0.0 pts | +0.0 pts | +0.0 pts |
| unbounded-loader-target | 10 | +0.0 pts | +0.0 pts | +0.0 pts |
| unresolved-specifier | 10 | +0.0 pts | +0.0 pts | +0.0 pts |
| value-escaped | 11 | +0.0 pts | +0.0 pts | +0.0 pts |
| vm-conservative | 8 | +0.0 pts | +0.0 pts | +0.0 pts |
| wrapper-unprovable | 9 | +0.0 pts | +0.0 pts | +0.0 pts |
| import-condition-divergence | 10 | +0.0 pts | +0.0 pts | +0.0 pts |
| destructure-rest | 1 | +0.0 pts | +0.0 pts | +0.0 pts |
| dynamic-import | 4 | +0.0 pts | +0.0 pts | +0.0 pts |
| reexport-namespace | 3 | +0.0 pts | +0.0 pts | +0.0 pts |
| unsupported-export-kind | 5 | +0.0 pts | +0.0 pts | +0.0 pts |
| unsupported-syntax | 4 | +0.0 pts | +0.0 pts | +0.0 pts |
| wasm-boundary | 1 | +0.0 pts | +0.0 pts | +0.0 pts |
| wrapper-depth | 1 | +0.0 pts | +0.0 pts | +0.0 pts |

## Pairwise-gate-off headroom — UNSOUND-DIAGNOSTIC, top-5-single-delta-ranked pairs (TARGET apps only)

| gate pair | apps tested | median delta | mean delta | max delta |
|---|---|---|---|---|
| binding-reassigned+dynamic-property-access | 10 | +0.0 pts | +0.0 pts | +0.0 pts |
| binding-reassigned+escaped-loader | 10 | +0.0 pts | +0.0 pts | +0.0 pts |
| binding-reassigned+export-object-mutation | 9 | +0.0 pts | +0.0 pts | +0.0 pts |
| binding-reassigned+export-star | 5 | +0.0 pts | +0.0 pts | +0.0 pts |
| dynamic-property-access+escaped-loader | 11 | +0.0 pts | +0.0 pts | +0.0 pts |
| dynamic-property-access+export-object-mutation | 10 | +0.0 pts | +0.0 pts | +0.0 pts |
| dynamic-property-access+export-star | 6 | +0.0 pts | +0.0 pts | +0.0 pts |
| escaped-loader+export-object-mutation | 10 | +0.0 pts | +0.0 pts | +0.0 pts |
| escaped-loader+export-star | 6 | +0.0 pts | +0.0 pts | +0.0 pts |
| export-object-mutation+export-star | 6 | +0.0 pts | +0.0 pts | +0.0 pts |
| binding-reassigned+generated-source-unknown | 1 | +0.0 pts | +0.0 pts | +0.0 pts |
| dynamic-property-access+generated-source-unknown | 2 | +0.0 pts | +0.0 pts | +0.0 pts |
| escaped-loader+generated-source-unknown | 2 | +0.0 pts | +0.0 pts | +0.0 pts |
| export-object-mutation+generated-source-unknown | 2 | +0.0 pts | +0.0 pts | +0.0 pts |
| binding-reassigned+destructure-rest | 1 | +0.0 pts | +0.0 pts | +0.0 pts |
| binding-reassigned+dynamic-import | 4 | +0.0 pts | +0.0 pts | +0.0 pts |
| destructure-rest+dynamic-import | 1 | +0.0 pts | +0.0 pts | +0.0 pts |
| destructure-rest+dynamic-property-access | 1 | +0.0 pts | +0.0 pts | +0.0 pts |
| destructure-rest+escaped-loader | 1 | +0.0 pts | +0.0 pts | +0.0 pts |
| dynamic-import+dynamic-property-access | 4 | +0.0 pts | +0.0 pts | +0.0 pts |
| dynamic-import+escaped-loader | 4 | +0.0 pts | +0.0 pts | +0.0 pts |
| dynamic-import+export-object-mutation | 3 | +0.0 pts | +0.0 pts | +0.0 pts |
| export-star+generated-source-unknown | 1 | +0.0 pts | +0.0 pts | +0.0 pts |

## Dominant blocking-sets by retained bytes

### Overall

| blocking-set | retained bytes | share |
|---|---|---|
| dynamic-import+escaped-loader+export-object-mutation+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+static-import+unbounded-loader-target+unresolved-specifier+unsupported-syntax+value-escaped+vm-conservative+wasm-boundary+wrapper-unprovable | 53743 KB | 5.3% |
| escaped-loader+export-object-mutation+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+unbounded-loader-target+unresolved-specifier+unsupported-syntax+value-escaped+vm-conservative+wasm-boundary+wrapper-unprovable | 48838 KB | 4.8% |
| escaped-loader+export-object-mutation+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+static-import+unbounded-loader-target+unresolved-specifier+value-escaped+vm-conservative+wrapper-unprovable | 42796 KB | 4.2% |
| escaped-loader+export-object-mutation+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+unbounded-loader-target+unresolved-specifier+value-escaped+vm-conservative+wrapper-unprovable | 35838 KB | 3.5% |
| escaped-loader+export-object-mutation+nft-positive-evidence+resolve-sink-retained+static-import+unbounded-loader-target+unresolved-specifier+value-escaped | 33884 KB | 3.3% |
| escaped-loader+export-object-mutation+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+static-import+unbounded-loader-target+unresolved-specifier+value-escaped+vm-conservative | 32221 KB | 3.2% |
| escaped-loader+generated-source-unknown+import-condition-divergence+native-boundary+package-domain-whole+require-cache-mutation+resolve-sink-retained+static-import+unbounded-loader-target+unresolved-specifier+value-escaped+vm-conservative+wasm-boundary+wrapper-depth+wrapper-unprovable | 31648 KB | 3.1% |
| escaped-loader+export-object-mutation+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+unbounded-loader-target+unresolved-specifier+value-escaped+vm-conservative | 28237 KB | 2.8% |
| escaped-loader+export-object-mutation+nft-positive-evidence+resolve-sink-retained+static-import+unbounded-loader-target+unresolved-specifier | 24391 KB | 2.4% |
| escaped-loader+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+unbounded-loader-target+unresolved-specifier+value-escaped+vm-conservative+wasm-boundary+wrapper-depth+wrapper-unprovable | 23158 KB | 2.3% |
| dynamic-import+escaped-loader+export-object-mutation+generated-source-unknown+require-cache-mutation+resolve-sink-retained+static-import+unbounded-loader-target+unresolved-specifier+unsupported-syntax+value-escaped+vm-conservative+wrapper-unprovable | 20983 KB | 2.1% |
| dynamic-import+dynamic-property-access+escaped-loader+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+unbounded-loader-target+unresolved-specifier+unsupported-syntax+value-escaped+vm-conservative+wasm-boundary+wrapper-depth+wrapper-unprovable | 18851 KB | 1.8% |
| dynamic-import+dynamic-property-access+escaped-loader+export-object-mutation+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+static-import+unbounded-loader-target+unresolved-specifier+unsupported-syntax+value-escaped+vm-conservative+wasm-boundary+wrapper-depth+wrapper-unprovable | 18698 KB | 1.8% |
| dynamic-property-access+escaped-loader+export-object-mutation+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+unbounded-loader-target+unresolved-specifier+unsupported-syntax+value-escaped+vm-conservative+wrapper-unprovable | 17108 KB | 1.7% |
| export-object-mutation+generated-source-unknown+nft-positive-evidence+resolve-sink-retained+static-import+unbounded-loader-target+value-escaped | 16925 KB | 1.7% |
| escaped-loader+export-object-mutation+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+unbounded-loader-target+unresolved-specifier+unsupported-syntax+value-escaped+vm-conservative+wrapper-unprovable | 16747 KB | 1.6% |
| escaped-loader+export-object-mutation+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+static-import+unbounded-loader-target+unresolved-specifier+unsupported-syntax+value-escaped+vm-conservative+wasm-boundary+wrapper-unprovable | 16263 KB | 1.6% |
| dynamic-import+escaped-loader+export-object-mutation+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+unbounded-loader-target+unresolved-specifier+unsupported-syntax+value-escaped+vm-conservative+wasm-boundary+wrapper-unprovable | 14769 KB | 1.4% |
| dynamic-property-access+escaped-loader+export-object-mutation+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+static-import+unbounded-loader-target+unresolved-specifier+unsupported-syntax+value-escaped+vm-conservative+wrapper-unprovable | 14595 KB | 1.4% |
| escaped-loader+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+unbounded-loader-target+unresolved-specifier+unsupported-syntax+value-escaped+vm-conservative+wasm-boundary+wrapper-unprovable | 13969 KB | 1.4% |

### Target only

| blocking-set | retained bytes |
|---|---|
| escaped-loader+export-object-mutation+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+static-import+unbounded-loader-target+unresolved-specifier+value-escaped+vm-conservative+wrapper-unprovable | 42796 KB |
| escaped-loader+export-object-mutation+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+unbounded-loader-target+unresolved-specifier+value-escaped+vm-conservative+wrapper-unprovable | 35838 KB |
| escaped-loader+export-object-mutation+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+static-import+unbounded-loader-target+unresolved-specifier+value-escaped+vm-conservative | 32221 KB |
| escaped-loader+generated-source-unknown+import-condition-divergence+native-boundary+package-domain-whole+require-cache-mutation+resolve-sink-retained+static-import+unbounded-loader-target+unresolved-specifier+value-escaped+vm-conservative+wasm-boundary+wrapper-depth+wrapper-unprovable | 31648 KB |
| escaped-loader+export-object-mutation+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+unbounded-loader-target+unresolved-specifier+value-escaped+vm-conservative | 28237 KB |
| escaped-loader+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+unbounded-loader-target+unresolved-specifier+value-escaped+vm-conservative+wasm-boundary+wrapper-depth+wrapper-unprovable | 23158 KB |
| dynamic-import+escaped-loader+export-object-mutation+generated-source-unknown+require-cache-mutation+resolve-sink-retained+static-import+unbounded-loader-target+unresolved-specifier+unsupported-syntax+value-escaped+vm-conservative+wrapper-unprovable | 20983 KB |
| escaped-loader+export-object-mutation+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+unbounded-loader-target+unresolved-specifier+unsupported-syntax+value-escaped+vm-conservative+wrapper-unprovable | 16747 KB |
| dynamic-property-access+escaped-loader+export-object-mutation+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+unbounded-loader-target+unresolved-specifier+unsupported-syntax+value-escaped+vm-conservative+wrapper-unprovable | 14926 KB |
| escaped-loader+export-object-mutation+nft-positive-evidence+resolve-sink-retained+static-import+unbounded-loader-target+unresolved-specifier | 13149 KB |

### Control only

| blocking-set | retained bytes |
|---|---|
| dynamic-import+escaped-loader+export-object-mutation+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+static-import+unbounded-loader-target+unresolved-specifier+unsupported-syntax+value-escaped+vm-conservative+wasm-boundary+wrapper-unprovable | 53743 KB |
| escaped-loader+export-object-mutation+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+unbounded-loader-target+unresolved-specifier+unsupported-syntax+value-escaped+vm-conservative+wasm-boundary+wrapper-unprovable | 48838 KB |
| escaped-loader+export-object-mutation+nft-positive-evidence+resolve-sink-retained+static-import+unbounded-loader-target+unresolved-specifier+value-escaped | 28804 KB |
| dynamic-import+dynamic-property-access+escaped-loader+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+unbounded-loader-target+unresolved-specifier+unsupported-syntax+value-escaped+vm-conservative+wasm-boundary+wrapper-depth+wrapper-unprovable | 18851 KB |
| dynamic-import+dynamic-property-access+escaped-loader+export-object-mutation+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+static-import+unbounded-loader-target+unresolved-specifier+unsupported-syntax+value-escaped+vm-conservative+wasm-boundary+wrapper-depth+wrapper-unprovable | 18698 KB |
| escaped-loader+export-object-mutation+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+static-import+unbounded-loader-target+unresolved-specifier+unsupported-syntax+value-escaped+vm-conservative+wasm-boundary+wrapper-unprovable | 16263 KB |
| dynamic-import+escaped-loader+export-object-mutation+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+unbounded-loader-target+unresolved-specifier+unsupported-syntax+value-escaped+vm-conservative+wasm-boundary+wrapper-unprovable | 14769 KB |
| escaped-loader+generated-source-unknown+native-boundary+require-cache-mutation+resolve-sink-retained+unbounded-loader-target+unresolved-specifier+unsupported-syntax+value-escaped+vm-conservative+wasm-boundary+wrapper-unprovable | 13969 KB |
| export-object-mutation+nft-positive-evidence+resolve-sink-retained+static-import+unbounded-loader-target+value-escaped+wasm-boundary | 13786 KB |
| dynamic-import+escaped-loader+generated-source-unknown+import-condition-divergence+native-boundary+package-domain-whole+require-cache-mutation+resolve-sink-retained+static-import+unbounded-loader-target+unresolved-specifier+unsupported-syntax+value-escaped+vm-conservative+wasm-boundary+wrapper-unprovable | 13612 KB |

## Capability / domain / result-flow / export-surface distributions (aggregated, all loaded apps)

### Capability site counts

| capability | sites |
|---|---|
| lexical-require | 294029 |
| dynamic-import | 6350 |
| createRequire-result | 132 |
| vm-injected | 100 |
| import-meta-resolve | 3 |
| module-require | 1 |

### Specifier/resolved-target domain tiers

| tier | sites |
|---|---|
| exact | 293980 |
| unbounded | 6590 |
| finite | 26 |
| package | 19 |

### Result flow

| kind | sites |
|---|---|
| escaped | 159223 |
| projected | 129885 |
| unused | 11507 |

### Export-surface confidence

closed: 51566, open: 88599

| open reason | modules |
|---|---|
| export-object-mutation | 87710 |
| export-star | 536 |
| unsupported-syntax | 302 |
| unsupported-export-kind | 54 |

## Analysis times

| app | prepareMs | strictMs | gateOffMs | pairwiseMs | refinementsMs | totalMs |
|---|---|---|---|---|---|---|
| nestjs-realworld | 20347 | 1407 | 15715 | 10544 | 5294 | 53376 |
| bulletproof-nodejs | 7187 | 670 | 2496 | 1665 | 868 | 12917 |
| express-realworld | 7611 | 150 | 401 | 356 | 171 | 8699 |
| fastify-demo | 7953 | 5655 | 9562 | 4611 | 2319 | 30175 |
| excalidraw-room | 19711 | 164 | 2046 | 1136 | 665 | 23755 |
| juice-shop | 30840 | 4847 | 45210 | 23478 | 10265 | 114801 |
| verdaccio | 178840 | 3367 | 8698 | 3732 | 2494 | 197242 |
| express-rest-boilerplate | 13265 | 4381 | 49860 | 30587 | 13363 | 111547 |
| hackathon-starter | 26984 | 11580 | 97821 | 46929 | 25132 | 208764 |
| nodebb | 47660 | 25792 | 345736 | 132999 | 76792 | 629337 |
| node-express-boilerplate | 12576 | 1715 | 10116 | 6387 | 3063 | 33927 |
| ghost | 92619 | 80363 | 563172 | 273042 | 147689 | 1159564 |
| nestjs-typescript-starter | 3205 | 114 | 894 | 588 | 280 | 5091 |
| json-server | 1322 | 16 | 139 | 89 | 59 | 1627 |
| parse-server | 26077 | 23785 | 383783 | 180224 | 76494 | 690611 |
| uptime-kuma | 27072 | 12217 | 122369 | 51402 | 28010 | 241421 |
| **total** | 523269 | 176223 | 1658018 | 767769 | 392958 | 3522854 |

Median per-app total analysis time: 82462ms.

## Widened-case counts (conservative-widening events recorded per app, strict config)

| app | widened events |
|---|---|
| ghost | 28478 |
| nodebb | 13239 |
| uptime-kuma | 13216 |
| hackathon-starter | 10822 |
| parse-server | 9657 |
| juice-shop | 5324 |
| verdaccio | 4363 |
| express-rest-boilerplate | 3427 |
| fastify-demo | 3310 |
| node-express-boilerplate | 3216 |
| nestjs-realworld | 1661 |
| express-realworld | 1067 |
| bulletproof-nodejs | 997 |
| excalidraw-room | 788 |
| json-server | 585 |
| nestjs-typescript-starter | 388 |

Total widened-case log entries across the corpus: 100538.
