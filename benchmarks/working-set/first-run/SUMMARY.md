# Initial working-set measurement — corpus-v1 first run

ADR-0007 experiment 1. **`COLD` means only "not selected for initial local placement."**
It does not mean dead, unused, unreachable, or removable. Nothing here demonstrates runtime
recoverability, miss latency, startup improvement, or production correctness.

Measured **19 of 19** frozen corpus applications (12 target, 7 control).

## Plans

```text
Plan A  NFT-positive + entrypoint + resolver metadata -> HOT, everything else candidate COLD
        (no hazard widening: dynamic require / createRequire / escaped loaders / vm /
         generated source / unbounded sinks do NOT expand the hot set)
Plan B  Plan A + every opaquePackages(universe).own package forced HOT

Universe -> Plan A  = intrinsic working-set opportunity
Plan A   -> Plan B  = opportunity consumed by current implementation constraints
```

## Candidate-COLD fraction — per-app distribution (all measured apps)

| denominator | plan | n | min | P25 | median | P75 | max |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| entire production universe | A | 19 | 71.9% | 76.4% | 81.3% | 85.6% | 97.6% |
| entire production universe | B | 19 | 10.7% | 66.6% | 72.7% | 82.4% | 97.4% |
| third-party production files | A | 19 | 65.1% | 78.9% | 82.6% | 86.1% | 97.6% |
| third-party production files | B | 19 | 9.2% | 68.0% | 74.4% | 83.4% | 97.4% |
| third-party JS (ADR-0006 D) | A | 19 | 49.2% | 65.9% | 69.6% | 79.8% | 98.6% |
| third-party JS (ADR-0006 D) | B | 19 | 10.2% | 60.3% | 65.6% | 75.9% | 98.6% |

## Candidate-COLD fraction — per-app distribution (target apps only)

| denominator | plan | n | min | P25 | median | P75 | max |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| entire production universe | A | 12 | 74.0% | 76.7% | 83.2% | 87.3% | 97.6% |
| entire production universe | B | 12 | 10.7% | 66.8% | 73.7% | 84.6% | 97.4% |
| third-party production files | A | 12 | 73.0% | 80.4% | 83.6% | 87.4% | 97.6% |
| third-party production files | B | 12 | 9.2% | 70.4% | 77.2% | 84.5% | 97.4% |
| third-party JS (ADR-0006 D) | A | 12 | 49.2% | 66.5% | 75.2% | 84.9% | 98.6% |
| third-party JS (ADR-0006 D) | B | 12 | 10.2% | 61.0% | 70.5% | 78.4% | 98.6% |

## Candidate-COLD fraction — byte-weighted corpus aggregate

`sum(candidate-COLD bytes) / sum(universe bytes)` — a big app counts more than a small one.

| denominator | plan A | plan B | plan A (targets) | plan B (targets) |
| --- | ---: | ---: | ---: | ---: |
| entire production universe | 77.6% | 62.2% | 84.4% | 68.3% |
| third-party production files | 81.2% | 68.6% | 85.2% | 71.3% |
| third-party JS (ADR-0006 D) | 70.7% | 67.4% | 78.3% | 73.9% |

## Plan A → Plan B: opportunity consumed by current constraints

| denominator | plan A cold | plan B cold | lost | lost % of A |
| --- | ---: | ---: | ---: | ---: |
| entire production universe | 4.80 GB | 3.85 GB | 950.8 MB | 19.8% |
| third-party production files | 4.14 GB | 3.50 GB | 642.3 MB | 15.5% |
| third-party JS (ADR-0006 D) | 1.37 GB | 1.31 GB | 64.8 MB | 4.7% |

Per-app loss (universe denominator): min 0.0%, median 6.3%, max 87.1%.

## HOT bytes by reason (marginal attribution)

Each byte is charged to exactly one reason — the first one it carries in the order below —
so a reason's total is the bytes it forces hot that no earlier reason already would.
`opaque-boundary` is last, so its total IS the Plan A → Plan B loss.

| reason | plan A | plan B |
| --- | ---: | ---: |
| nft-positive | 1.38 GB | 1.38 GB |
| entrypoint | 0.0 KB | 0.0 KB |
| resolver-metadata | 8.8 MB | 8.8 MB |
| opaque-boundary | 0.0 KB | 950.8 MB |
| no-positive-evidence | 0.0 KB | 0.0 KB |

## What actually made Plan B force those packages hot

`opaquePackages().own` marks a package on any of five very different facts. Classified here
(never refined — that is out of scope for this run) so the dominant cause is visible.
Artifact evidence wins over the install-script proxy, so `install-script` counts only packages
where the script is the SOLE signal.

| evidence | packages | files | forced-HOT bytes | % of total loss |
| --- | ---: | ---: | ---: | ---: |
| native-artifact | 52 | 3716 | 420.6 MB | 44.2% |
| install-script | 33 | 43859 | 317.3 MB | 33.4% |
| wasm-artifact | 26 | 5595 | 207.4 MB | 21.8% |
| binding-gyp | 18 | 835 | 5.5 MB | 0.6% |

### …of which: the application's OWN root package

A separate cause from "a dependency ships a native artifact". When the ROOT package is
marked opaque, every first-party file the application owns is forced hot at once — one `.wasm`
anywhere in a monorepo outside `node_modules`, or a build script in the root manifest, is enough.

| app | evidence | forced-HOT bytes | % of total loss |
| --- | --- | ---: | ---: |
| strapi | install-script | 138.7 MB | 14.6% |
| n8n | wasm-artifact | 70.2 MB | 7.4% |
| outline | install-script | 19.6 MB | 2.1% |
| juice-shop | install-script | 14.4 MB | 1.5% |
| parse-server | install-script | 8.5 MB | 0.9% |
| hackathon-starter | install-script | 1.9 MB | 0.2% |

**253.3 MB — 26.6% of the entire Plan A → Plan B loss is first-party application code**, forced hot because the app's own root package tripped a heuristic aimed at native dependencies.

## Per-application results

| app | cat | universe | files | pkgs | cold A | cold B | 3p-JS cold A | 3p-JS cold B |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| n8n | C | 2.07 GB | 252545 | 2381 | 72.0% | 53.7% | 62.8% | 58.9% |
| outline | T | 854.7 MB | 85479 | 1709 | 84.4% | 67.0% | 76.0% | 74.9% |
| strapi | C | 820.5 MB | 117015 | 2019 | 71.9% | 52.8% | 65.8% | 64.7% |
| nodebb | C | 531.1 MB | 47796 | 903 | 77.4% | 72.6% | 72.8% | 72.4% |
| ghost | C | 488.5 MB | 66781 | 1249 | 81.1% | 69.1% | 66.9% | 64.1% |
| hackathon-starter | T | 283.8 MB | 28578 | 502 | 87.3% | 65.5% | 69.6% | 58.8% |
| juice-shop | T | 221.1 MB | 21112 | 921 | 75.8% | 66.1% | 77.0% | 77.0% |
| uptime-kuma | C | 172.0 MB | 26604 | 694 | 79.0% | 73.4% | 60.3% | 58.4% |
| parse-server | C | 142.4 MB | 23451 | 634 | 86.7% | 74.8% | 84.6% | 79.1% |
| nestjs-realworld | T | 126.1 MB | 15039 | 589 | 87.4% | 87.2% | 82.5% | 82.5% |
| excalidraw-room | T | 108.1 MB | 6072 | 269 | 97.6% | 97.4% | 98.6% | 98.6% |
| express-realworld | T | 96.5 MB | 1975 | 128 | 82.4% | 10.7% | 92.0% | 10.2% |
| node-express-boilerplate | T | 62.4 MB | 8183 | 393 | 83.9% | 83.7% | 74.4% | 74.4% |
| express-rest-boilerplate | T | 60.1 MB | 11776 | 617 | 74.0% | 70.0% | 65.9% | 61.7% |
| verdaccio | C | 53.1 MB | 8707 | 310 | 84.2% | 83.6% | 66.5% | 65.6% |
| bulletproof-nodejs | T | 38.2 MB | 5337 | 295 | 77.0% | 74.6% | 66.6% | 66.5% |
| fastify-demo | T | 36.0 MB | 7564 | 168 | 95.4% | 95.4% | 92.3% | 92.3% |
| nestjs-typescript-starter | T | 10.2 MB | 4067 | 106 | 74.4% | 72.7% | 49.2% | 49.0% |
| json-server | T | 2.8 MB | 1137 | 46 | 81.3% | 81.3% | 62.5% | 62.5% |

## Package structure (Plan B)

`package.json` is forced hot in every package as resolver metadata, so the plan-faithful
classification calls almost every package "mixed" and answers nothing. The `non-meta` columns
exclude manifests and are the ones that distinguish package-level from file-level opportunity:
`all-cold (non-meta)` is what a package-granularity virtualizer would also have caught.

| app | pkgs | all-hot | mixed | all-cold | all-hot (non-meta) | mixed (non-meta) | all-cold (non-meta) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bulletproof-nodejs | 295 | 5 | 290 | 0 | 5 | 153 | 137 |
| excalidraw-room | 269 | 2 | 267 | 0 | 2 | 76 | 191 |
| express-realworld | 128 | 5 | 123 | 0 | 5 | 96 | 27 |
| express-rest-boilerplate | 617 | 3 | 614 | 0 | 3 | 382 | 232 |
| fastify-demo | 168 | 0 | 168 | 0 | 0 | 53 | 115 |
| ghost | 1249 | 101 | 1148 | 0 | 101 | 724 | 424 |
| hackathon-starter | 502 | 6 | 496 | 0 | 6 | 346 | 150 |
| json-server | 46 | 0 | 46 | 0 | 0 | 39 | 7 |
| juice-shop | 921 | 5 | 916 | 0 | 5 | 471 | 445 |
| n8n | 2381 | 309 | 2072 | 0 | 309 | 1460 | 612 |
| nestjs-realworld | 589 | 43 | 546 | 0 | 43 | 229 | 317 |
| nestjs-typescript-starter | 106 | 4 | 102 | 0 | 4 | 94 | 8 |
| node-express-boilerplate | 393 | 2 | 391 | 0 | 2 | 199 | 192 |
| nodebb | 903 | 17 | 886 | 0 | 17 | 479 | 407 |
| outline | 1709 | 87 | 1622 | 0 | 87 | 890 | 732 |
| parse-server | 634 | 10 | 624 | 0 | 10 | 267 | 357 |
| strapi | 2019 | 142 | 1877 | 0 | 142 | 1273 | 604 |
| uptime-kuma | 694 | 10 | 684 | 0 | 10 | 480 | 204 |
| verdaccio | 310 | 12 | 298 | 0 | 12 | 231 | 67 |

### File-level vs package-level opportunity (Plan B)

How much of the cold opportunity a package-granularity virtualizer would ALSO reach, versus
the part that exists only because placement is per-file.

| granularity | cold bytes | share |
| --- | ---: | ---: |
| wholly-cold packages (package-level reaches these) | 1.62 GB | 42.2% |
| partly-cold packages (file-level only) | 2.22 GB | 57.8% |
| **total** | 3.85 GB | 100% |

Per-app file-level-only share: min 1.4%, median 50.0%, max 88.8%.

### Largest fully-cold packages (Plan B, non-meta)

| app | package | cold bytes | files |
| --- | --- | ---: | ---: |
| excalidraw-room | typescript@4.2.3 | 59.2 MB | 170 |
| nestjs-realworld | typescript@3.8.3 | 52.2 MB | 169 |
| outline | @linear/sdk@58.1.0 | 37.7 MB | 56 |
| nodebb | wordnet-db@3.1.14 | 35.4 MB | 15 |
| nodebb | bootswatch@5.3.8 | 32.0 MB | 211 |
| strapi | @formatjs/intl-displaynames@6.6.6 | 31.7 MB | 1174 |
| nodebb | emoji-datasource-google@3.0.0 | 28.9 MB | 2410 |
| n8n | @typescript/typescript-darwin-arm64@7.0.2 | 27.5 MB | 113 |
| ghost | viem@2.55.11 | 26.1 MB | 10045 |
| hackathon-starter | @fortawesome/fontawesome-free@7.3.1 | 25.3 MB | 5839 |
| n8n | typescript@5.9.3 | 23.6 MB | 132 |
| n8n | @linear/sdk@76.0.0 | 21.9 MB | 22 |
| excalidraw-room | prettier@2.2.1 | 19.2 MB | 33 |
| n8n | selenium-webdriver@4.39.0 | 18.4 MB | 100 |
| outline | @mermaid-js/layout-elk@0.2.2 | 15.3 MB | 27 |

### Largest partially-cold (mixed) packages (Plan B, non-meta)

| app | package | cold bytes | hot byte fraction | files |
| --- | --- | ---: | ---: | ---: |
| n8n | element-plus@2.4.3 | 90.6 MB | 4.0% | 6492 |
| outline | mermaid@11.16.1 | 80.7 MB | 3.4% | 1171 |
| nodebb | ace-builds@1.44.0 | 54.0 MB | 2.1% | 2151 |
| n8n | n8n@2.36.0 | 29.1 MB | 53.1% | 8808 |
| outline | @emoji-mart/data@1.2.1 | 27.5 MB | 1.6% | 98 |
| ghost | ghost@6.60.0-rc.0 | 22.7 MB | 18.7% | 3008 |
| hackathon-starter | js-tiktoken@1.0.21 | 22.4 MB | 0.1% | 32 |
| n8n | js-tiktoken@1.0.21 | 22.4 MB | 0.1% | 32 |
| n8n | pdf-parse@2.4.5 | 20.7 MB | 2.7% | 110 |
| outline | date-fns@3.6.0 | 20.3 MB | 8.6% | 4782 |
| strapi | hls.js@1.5.15 | 19.1 MB | 5.6% | 142 |
| strapi | @strapi/admin@5.52.1 | 18.1 MB | 20.0% | 3495 |
| node-express-boilerplate | swagger-ui-dist@3.51.1 | 17.6 MB | 7.6% | 20 |
| n8n | typescript@6.0.2 | 15.2 MB | 37.6% | 140 |
| hackathon-starter | stripe@22.5.0 | 15.1 MB | 6.4% | 1454 |

## Failures and non-measurements

None — all 19 frozen corpus applications completed with positive evidence.
