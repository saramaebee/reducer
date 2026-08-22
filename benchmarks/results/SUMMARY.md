# reducer real-world benchmark summary

| project | fw | modules | deps | A prod | B NFT JS | C bundle | D reducer JS | Δ vs NFT | stubbed | hazards | tests | startup |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| express-realworld | express | mixed | 11 | 12911 KB | 4300 KB | 942 KB | 4300 KB | 0.0% | 0 | dynamic-require<br>runtime-code-generation<br>nft-warning | - | - |
| fastify-demo | fastify | mixed | 23 | 103778 KB | 1329 KB | 592 KB | 1329 KB | 0.0% | 0 | dynamic-import-nonliteral<br>dynamic-require<br>require-cache-mutation<br>runtime-code-generation | - | - |
| node-express-boilerplate | express | cjs | 24 | 174638 KB | 8276 KB | 4702 KB | 8276 KB | 0.0% | 0 | dynamic-require<br>runtime-code-generation<br>nft-warning | true | - |
| json-server | - | mixed | 13 | 149478 KB | 456 KB | 191 KB | 456 KB | 0.0% | 0 | runtime-code-generation<br>unsupported-syntax | - | - |
| uptime-kuma | express | mixed | 84 | 429406 KB | 26593 KB | FAIL | 26593 KB | 0.0% | 0 | dynamic-require<br>runtime-code-generation<br>dynamic-import-nonliteral<br>nft-warning | - | - |

**Median incremental reduction vs NFT:** 0.0% across 5 analyzable project(s); bundler passed on 4/5.

## Retention reasons (aggregate, estimated JS bytes)

| reason | est. bytes | symbols | modules | projects |
|---|---|---|---|---|
| global-hazard:runtime-code-generation | 11098 KB | 18812 | 6071 | 5 |
| global-hazard:dynamic-require | 10882 KB | 18602 | 5980 | 4 |
| global-hazard:nft-warning | 10550 KB | 17860 | 5677 | 3 |
| global-hazard:dynamic-import-nonliteral | 6728 KB | 15120 | 4584 | 2 |
| global-hazard:require-cache-mutation | 331 KB | 742 | 303 | 1 |
| global-hazard:unsupported-syntax | 216 KB | 210 | 91 | 1 |
