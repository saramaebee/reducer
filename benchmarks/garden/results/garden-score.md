# Garden score

Reducer 0.0.1 under node v24.3.0.
Global hazards (widen ALL retention): dynamic-require, runtime-code-generation, dynamic-import-nonliteral, require-cache-mutation, unsupported-syntax, nft-warning

| axis | result | severity |
|---|---|---|
| false removal | 0 MUST_RETAIN symbols transformed | clean |
| unsafe optimism | 0 conservative/control symbols transformed | clean |
| over-retention | 16/16 MUST_REMOVE symbols retained | precision (non-fatal) |
| file-level unsound removal | 0 MUST_REMOVE modules dropped at trace time (—) | clean |
| achieved/ceiling (fabricated) | 0/16 = 0.0% | product metric |
| achieved/ceiling (validator positive control) | 0/102 = 0.0% | product metric |

## Behavioral oracle

- original replay: clean
- reduced service: all contracts identical on the reduced service


## Red team (__force)

16 forced invocations, 0 breaches.




**Critical findings: 0** — the reduction is sound on this oracle.
