# Garden score

Reducer 0.0.1 under node v24.3.0.
Global hazards (widen ALL retention): dynamic-require, runtime-code-generation, require-cache-mutation, dynamic-import-nonliteral, unsupported-syntax, nft-warning

| axis | result | severity |
|---|---|---|
| false removal | 0 MUST_RETAIN symbols transformed | clean |
| unsafe optimism | 0 conservative/control symbols transformed | clean |
| over-retention | 13/16 MUST_REMOVE symbols retained | precision (non-fatal) |
| file-level unsound removal | 3 MUST_REMOVE modules dropped at trace time (require-unbounded-bounded-projection:notFoo, createrequire:dead, reconstructed-require-wrapper:otherUnused) | **CRITICAL** (whole module vanished, incl. its conservative siblings) |
| achieved/ceiling (fabricated) | 0/16 = 0.0% | product metric |
| achieved/ceiling (validator positive control) | 0/102 = 0.0% | product metric |

## Behavioral oracle

- original replay: clean
- reduced service: 14 contract divergences — unsound removals (crashed and was rebooted 1× mid-suite)
  - `/fab/createrequire/used` status: expected 200 — got 500 body={"ok":false,"name":"Error","message":"Cannot find module 'cr-target'\nRequire stack:\n- /Users/sara/personal/saratonin.dev/reducer/benchmarks/garden/results/tmp/reduced/node_modules/fab-createrequire/
  - `/fab/getbuiltinmodule-factory/__exercise?m=gbf-target` status: expected 200 — got 500 body={"ok":false,"name":"Error","message":"Cannot find module 'gbf-target'\nRequire stack:\n- /Users/sara/personal/saratonin.dev/reducer/benchmarks/garden/results/tmp/reduced/node_modules/fab-getbuiltinmod
  - `/fab/reconstructed-require-wrapper/__exercise` body: expected {"ok":true,"value":"reconstructed-require-wrapper:bar:12c9d-xomxomxomnylnylbis"} — got {"ok":true,"value":"rrw:absent:garden"}
  - `/fab/reconstructed-require-unknown-caller/__exercise` status: expected 200 — got 500 body={"ok":false,"name":"TypeError","message":"Cannot read properties of null (reading 'ping')"}
  - `/fab/escaped-loader/__exercise` status: expected 200 — got 500 body={"ok":false,"name":"Error","message":"Cannot find module 'el-target'\nRequire stack:\n- /Users/sara/personal/saratonin.dev/reducer/benchmarks/garden/results/tmp/reduced/node_modules/fab-escaped-loader
  - `/fab/dynamic-import-nonliteral/__exercise?which=target` status: expected 200 — got 500 body={"ok":false,"name":"Error","message":"Cannot find package 'din-target' imported from /Users/sara/personal/saratonin.dev/reducer/benchmarks/garden/results/tmp/reduced/node_modules/fab-dynamic-import-no
  - `/fab/eval-constant-capable/__exercise` status: expected 200 — got 500 body={"ok":false,"name":"Error","message":"Cannot find module 'ecc-target'\nRequire stack:\n- /Users/sara/personal/saratonin.dev/reducer/benchmarks/garden/results/tmp/reduced/node_modules/fab-eval-constant
  - `/fab/direct-eval-lexical/__exercise` status: expected 200 — got 500 body={"ok":false,"name":"Error","message":"Cannot find module 'del-target'\nRequire stack:\n- /Users/sara/personal/saratonin.dev/reducer/benchmarks/garden/results/tmp/reduced/node_modules/fab-direct-eval-l
  - `/fab/require-pkgscoped/__exercise?name=one` status: expected 200 — got 500 body={"ok":false,"name":"Error","message":"Cannot find module 'rps-scopedtarget/one'\nRequire stack:\n- /Users/sara/personal/saratonin.dev/reducer/benchmarks/garden/results/tmp/reduced/node_modules/fab-req
  - `/fab/require-unbounded-bounded-projection/foo?m=rubp-target` status: expected 200 — got 500 body={"ok":false,"name":"Error","message":"Cannot find module 'rubp-target'\nRequire stack:\n- /Users/sara/personal/saratonin.dev/reducer/benchmarks/garden/results/tmp/reduced/node_modules/fab-require-unbo
  - `/fab/require-unbounded-computed-projection/__exercise?m=rucp-target&k=alpha` status: expected 200 — got 500 body={"ok":false,"name":"Error","message":"Cannot find module 'rucp-target'\nRequire stack:\n- /Users/sara/personal/saratonin.dev/reducer/benchmarks/garden/results/tmp/reduced/node_modules/fab-require-unbo
  - `/fab/require-value-escape/__exercise?m=rve-target` status: expected 200 — got 500 body={"ok":false,"name":"Error","message":"Cannot find module 'rve-target'\nRequire stack:\n- /Users/sara/personal/saratonin.dev/reducer/benchmarks/garden/results/tmp/reduced/node_modules/fab-require-value
  - `/fab/vm-injected-loader/__exercise` status: expected 200 — got 500 body={"ok":false,"name":"Error","message":"Cannot find module 'vil-target'\nRequire stack:\n- /Users/sara/personal/saratonin.dev/reducer/benchmarks/garden/results/tmp/reduced/node_modules/fab-vm-injected-l
  - `/real/sqljs` status: expected 200 — got 500 body={"ok":false,"name":"Error","message":"Error: ENOENT: no such file or directory, open '/Users/sara/personal/saratonin.dev/reducer/benchmarks/garden/results/tmp/reduced/node_modules/sql.js/dist/sql-wasm

## Red team (__force)

16 forced invocations, 0 breaches.


## Anomalies

- require-unbounded-bounded-projection:notFoo: sentinel absent WITHOUT a recorded transformation — its module was dropped at trace time (file-level unsound removal, not achieved reduction)
- createrequire:dead: sentinel absent WITHOUT a recorded transformation — its module was dropped at trace time (file-level unsound removal, not achieved reduction)
- reconstructed-require-wrapper:otherUnused: sentinel absent WITHOUT a recorded transformation — its module was dropped at trace time (file-level unsound removal, not achieved reduction)


**Critical findings: 17** — soundness violations detected; see JSON for full detail.
