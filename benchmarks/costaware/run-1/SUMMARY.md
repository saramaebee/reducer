# Cost-aware traffic-warm — generated tables

Preregistration: [`../DESIGN.md`](../DESIGN.md). Every rung is a MEASURED
prewarm cost, chosen per arm by an application-free probe of each candidate
manifest (DESIGN §8.1); the nominal parameter is only a knob.


---

## strapi

Universe 123474 files / 915.0 MB; blob 228.3 MB in 75245 chunks (22870 shared). Frozen band 80 ms; eager arm's own worst post-admission window p99 135 ms.

### 1. The ladder — what a rung actually cost, and what it bought

| rung | arm | param | probe-measured prewarm | in-trial prewarm | manifest entries | resident files | resident MB | backend req @admit | backend MB @admit |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2.0 s | G1 | 1600 | 1881 ms | 2000 ms | 734 | — | — | 334 | 95.6 |
| 2.0 s | G1C | 1600 | 1887 ms | 2009 ms | 21756 | — | — | 312 | 98.9 |
| 2.0 s | R1 | 1600 | 1877 ms | 2015 ms | 140 | — | — | 363 | 96.7 |
| 2.0 s | R1C | 1600 | 1854 ms | 2007 ms | 19582 | — | — | 371 | 100.6 |
| 4.0 s | G1 | 3200 | 3715 ms | 4061 ms | 1271 | — | — | 436 | 97.5 |
| 4.0 s | G1C | 3200 | 3382 ms | 4055 ms | 37066 | — | — | 382 | 98.9 |
| 4.0 s | R1 | 3200 | 3629 ms | 4070 ms | 801 | — | — | 480 | 95.5 |
| 4.0 s | R1C | 3200 | 3255 ms | 3984 ms | 37670 | — | — | 398 | 97.2 |
| 8.0 s | G1 | 6400 | 6847 ms | 5508 ms | 2141 | — | — | 517 | 93.1 |
| 8.0 s | G1C | 6400 | 6221 ms | 6889 ms | 63135 | — | — | 505 | 94.6 |
| 8.0 s | R1 | 6400 | 6169 ms | 6024 ms | 1235 | — | — | 643 | 96.1 |
| 8.0 s | R1C | 6400 | 6183 ms | 7029 ms | 61806 | — | — | 546 | 100.5 |
| 14.0 s | G1 | 12800 | 12793 ms | 8914 ms | 3208 | — | — | 792 | 78.0 |
| 14.0 s | G1C | 12800 | 11334 ms | 11478 ms | 74874 | — | — | 820 | 133.4 |
| 14.0 s | R1 | 12800 | 11410 ms | 7966 ms | 2048 | — | — | 725 | 92.0 |
| 14.0 s | R1C | 12800 | 11154 ms | 11342 ms | 74885 | — | — | 810 | 136.6 |
| 22.0 s | G1 | 51200 | 19770 ms | 19712 ms | 75033 | — | — | 1004 | 229.4 |
| 22.0 s | G1C | 25600 | 19815 ms | 19779 ms | 75033 | — | — | 999 | 229.1 |
| 22.0 s | R1 | 25600 | 22701 ms | 13447 ms | 7085 | — | — | 1149 | 108.3 |
| 22.0 s | R1C | 51200 | 19840 ms | 19784 ms | 75033 | — | — | 1001 | 229.1 |

### 2. Equal measured prewarm time → outcome

`T_steady − T0` is the preregistered primary metric, computed against the frozen band.
`T_steady(eager) − T0` is the same construction against a REACHABLE threshold — the eager
arm's own worst cold post-admission window — because the frozen band comes from the eager
arm's WARM pass and no cold pass can meet it (experiment 4 amendment A4). Both are shown;
neither replaces the other. `T_traffic − T0` is admission delay.

| rung | arm | T_steady(eager)−T0 | reached | T_steady(band)−T0 | reached | T_traffic−T0 | max window p95 | max window p99 | post-adm remote req | residual prefetch | demand faults | post-adm MB |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2.0 s | G1 | 26002 | 4/4 | 28800 | 2/4 | 23816 | 82 | 152 | 4 | 0 | 4 | 0.2 |
| 2.0 s | G1C | 24766 | 3/4 | 27340 | 2/4 | 22410 | 83 | 192 | 7 | 0 | 7 | 0.7 |
| 2.0 s | R1 | 26375 | 4/4 | 28772 | 2/4 | 24131 | 82 | 267 | 7 | 0 | 7 | 1.1 |
| 2.0 s | R1C | 26764 | 4/4 | 29323 | 3/4 | 24516 | 81 | 157 | 6 | 0 | 6 | 0.6 |
| 4.0 s | G1 | 24876 | 4/4 | 25380 | 3/4 | 22795 | 82 | 158 | 3 | 0 | 3 | 0.0 |
| 4.0 s | G1C | 22452 | 4/4 | 22695 | 2/4 | 19851 | 81 | 228 | 12 | 0 | 12 | 1.1 |
| 4.0 s | R1 | 24996 | 4/4 | 26447 | 2/4 | 22771 | 82 | 282 | 7 | 0 | 7 | 1.0 |
| 4.0 s | R1C | 22316 | 4/4 | 25227 | 2/4 | 20148 | 82 | 130 | 9 | 0 | 9 | 1.2 |
| 8.0 s | G1 | 22929 | 4/4 | 25487 | 3/4 | 20740 | 83 | 161 | 3 | 0 | 3 | 0.0 |
| 8.0 s | G1C | 17544 | 4/4 | 20151 | 3/4 | 15696 | 78 | 131 | 1 | 0 | 1 | 0.9 |
| 8.0 s | R1 | 23497 | 4/4 | 24354 | 1/4 | 21390 | 82 | 155 | 3 | 0 | 3 | 0.8 |
| 8.0 s | R1C | 18691 | 4/4 | 20613 | 3/4 | 16992 | 76 | 131 | 1 | 0 | 1 | 0.1 |
| 14.0 s | G1 | 20703 | 4/4 | 21371 | 1/4 | 18352 | 84 | 219 | 7 | 0 | 7 | 1.1 |
| 14.0 s | G1C | 19187 | 4/4 | 19456 | 1/4 | 17614 | 79 | 132 | 0 | 0 | 0 | 0.0 |
| 14.0 s | R1 | 22660 | 4/4 | 24244 | 1/4 | 20409 | 82 | 202 | 5 | 0 | 5 | 0.5 |
| 14.0 s | R1C | 19656 | 4/4 | 20441 | 2/4 | 18097 | 81 | 133 | 0 | 0 | 0 | 0.0 |
| 22.0 s | G1 | 25175 | 4/4 | 25308 | 2/4 | 23589 | 78 | 131 | 0 | 0 | 0 | 0.0 |
| 22.0 s | G1C | 25249 | 4/4 | 26713 | 3/4 | 23681 | 76 | 128 | 0 | 0 | 0 | 0.0 |
| 22.0 s | R1 | 23215 | 4/4 | 23316 | 1/4 | 21559 | 81 | 129 | 0 | 0 | 0 | 0.0 |
| 22.0 s | R1C | 25237 | 4/4 | 28590 | 1/4 | 23673 | 82 | 130 | 0 | 0 | 0 | 0.0 |
| eager | E0 | 28128 | 4/4 | 30766 | 2/4 | 26453 | 81 | 132 | 0 | 0 | 0 | 0.0 |

### 3. Long-tail first-hit latency, arrival position 1 only


**admin-background**

| rung | G1 | G1C | R1 | R1C | E0 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 2.0 s | 26 | 23 | 23 | 23 | 25 |
| 4.0 s | 27 | 31 | 25 | 23 | 25 |
| 8.0 s | 22 | 24 | 26 | 23 | 25 |
| 14.0 s | 25 | 24 | 21 | 25 | 25 |
| 22.0 s | 23 | 22 | 25 | 24 | 25 |

**error-path**

| rung | G1 | G1C | R1 | R1C | E0 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 2.0 s | — | — | — | — | — |
| 4.0 s | — | — | — | — | — |
| 8.0 s | — | — | — | — | — |
| 14.0 s | — | — | — | — | — |
| 22.0 s | — | — | — | — | — |

**optional-feature**

| rung | G1 | G1C | R1 | R1C | E0 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 2.0 s | 284 | 424 | 267 | 365 | 152 |
| 4.0 s | 362 | 580 | 275 | 569 | 152 |
| 8.0 s | 162 | 444 | 145 | 269 | 152 |
| 14.0 s | 275 | 147 | 306 | 146 | 152 |
| 22.0 s | 148 | 145 | 146 | 155 | 152 |

**rare-route**

| rung | G1 | G1C | R1 | R1C | E0 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 2.0 s | 4 | 5 | 6 | 5 | 5 |
| 4.0 s | 4 | 6 | 5 | 5 | 5 |
| 8.0 s | 5 | 6 | 5 | 4 | 5 |
| 14.0 s | 5 | 5 | 5 | 5 | 5 |
| 22.0 s | 6 | 5 | 5 | 5 | 5 |

**tenant-config**

| rung | G1 | G1C | R1 | R1C | E0 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 2.0 s | 91 | 92 | 95 | 91 | 93 |
| 4.0 s | 94 | 92 | 92 | 95 | 93 |
| 8.0 s | 93 | 93 | 99 | 95 | 93 |
| 14.0 s | 97 | 98 | 94 | 104 | 93 |
| 22.0 s | 92 | 96 | 93 | 92 | 93 |

### 4. Equal outcome — smallest rung that is eager-matched

Eager-matched: median worst post-admission window p99 ≤ the worst the eager arm itself produced (experiment 4 amendment A4, reused).

| arm | smallest eager-matched rung | its measured prewarm |
| --- | --- | ---: |
| G1 | 22.0 s | 19770 ms |
| G1C | 8.0 s | 6221 ms |
| R1 | 22.0 s | 22701 ms |
| R1C | 4.0 s | 3255 ms |

### 5. Prewarm waste — resident at admission, never touched by any workload

| rung | arm | waste files | waste MB | needed TEST files still missing |
| ---: | --- | ---: | ---: | ---: |
| 2.0 s | G1 | — | — | — |
| 2.0 s | G1C | — | — | — |
| 2.0 s | R1 | — | — | — |
| 2.0 s | R1C | — | — | — |
| 4.0 s | G1 | — | — | — |
| 4.0 s | G1C | — | — | — |
| 4.0 s | R1 | — | — | — |
| 4.0 s | R1C | — | — | — |
| 8.0 s | G1 | — | — | — |
| 8.0 s | G1C | — | — | — |
| 8.0 s | R1 | — | — | — |
| 8.0 s | R1C | — | — | — |
| 14.0 s | G1 | — | — | — |
| 14.0 s | G1C | — | — | — |
| 14.0 s | R1 | — | — | — |
| 14.0 s | R1C | — | — | — |
| 22.0 s | G1 | — | — | — |
| 22.0 s | G1C | — | — | — |
| 22.0 s | R1 | — | — | — |
| 22.0 s | R1C | — | — | — |

### 6. The physical oracle — perfect future knowledge, priced in the same units

```text
needed TEST files       5118
unique chunks           4834
backend requests        1697
backend bytes           10.9 MB
predicted prewarm       18078 ms
```

Against what a cost-aware arm actually pays for far more content:

| arm | rung | resident files | measured prewarm | backend requests |
| --- | ---: | ---: | ---: | ---: |
| G1C | 2.0 s | — | 1887 ms | 132 |
| R1C | 2.0 s | — | 1854 ms | 133 |
| G1C | 4.0 s | — | 3382 ms | 275 |
| R1C | 4.0 s | — | 3255 ms | 272 |
| G1C | 8.0 s | — | 6221 ms | 536 |
| R1C | 8.0 s | — | 6183 ms | 537 |
| G1C | 14.0 s | — | 11334 ms | 936 |
| R1C | 14.0 s | — | 11154 ms | 925 |
| G1C | 22.0 s | — | 19815 ms | 1169 |
| R1C | 22.0 s | — | 19840 ms | 1169 |

### 6b. Do the two prediction sources still disagree once both pay real retrieval cost?

Jaccard overlap of what each arm makes RESIDENT, from the frozen manifests alone — no trial, no latency.

| rung | G1C vs R1C: chunks | resident files | R1C-only | G1C-only | G1 vs R1: chunks | resident files |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2.0 s | 0.481 | 0.570 | 7984 | 14591 | 0.019 | 0.013 |
| 4.0 s | 0.581 | 0.652 | 13731 | 15635 | 0.018 | 0.023 |
| 8.0 s | 0.905 | 0.931 | 3128 | 4599 | 0.030 | 0.026 |
| 14.0 s | 0.999 | 1.000 | 24 | 12 | 0.070 | 0.049 |
| 22.0 s | 1.000 | 1.000 | 0 | 0 | 0.094 | 0.112 |

### 7. Why experiment 4 lost — its own manifests, re-priced physically

| exp-4 arm | byte budget | files | file MB | unique chunks | backend req | backend MB | overfetch | predicted prewarm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| G1 | 5% | 6579 | 45.8 | 5941 | 1588 | 13.9 | 1.1× | 16985 ms |
| G1 | 10% | 15383 | 91.5 | 11238 | 1349 | 21.0 | 1.05× | 14600 ms |
| G1 | 20% | 31878 | 183.0 | 19241 | 955 | 33.4 | 1.02× | 10678 ms |
| G1 | 40% | 49922 | 366.0 | 29174 | 1116 | 92.8 | 1.01× | 13283 ms |
| G2 | 5% | 35131 | 45.8 | 27421 | 3853 | 18.2 | 1.21× | 40714 ms |
| G2 | 10% | 62381 | 91.5 | 48018 | 4370 | 33.4 | 1.1× | 46351 ms |
| G2 | 20% | 86311 | 183.0 | 65954 | 2961 | 57.2 | 1.02× | 32003 ms |
| G2 | 40% | 102039 | 366.0 | 73607 | 1303 | 98.6 | 1× | 15328 ms |
| R1 | 5% | 66628 | 45.8 | 42647 | 5263 | 19.6 | 1.38× | 55465 ms |
| R1 | 10% | 82730 | 91.5 | 53116 | 5326 | 28.0 | 1.13× | 56253 ms |
| R1 | 20% | 96794 | 183.0 | 62281 | 3728 | 42.8 | 1.02× | 39791 ms |
| R1 | 40% | 106512 | 366.0 | 68803 | 1567 | 73.7 | 1.01× | 17697 ms |
| R2 | 5% | 40358 | 45.8 | 30802 | 5190 | 19.8 | 1.31× | 54705 ms |
| R2 | 10% | 65696 | 91.5 | 52206 | 5259 | 33.8 | 1.1× | 55644 ms |
| R2 | 20% | 79542 | 183.0 | 64337 | 2683 | 57.5 | 1.01× | 29104 ms |
| R2 | 40% | 85138 | 366.0 | 69111 | 1215 | 102.4 | 1× | 14466 ms |

### 8. Correctness

```text
arm-vs-eager trial comparisons   80
status mismatches                0
body-length mismatches           0
body-fingerprint mismatches      0
declared-header mismatches       0
requests outside declared expect 0
```

### 9. Cost-model accuracy on the deployed manifests

| arm | rung | predicted | probe-measured | in-trial |
| --- | ---: | ---: | ---: | ---: |
| G1 | 2000 ms | 1595 ms | 1881 ms | 2000 ms |
| G1C | 2000 ms | 1598 ms | 1887 ms | 2009 ms |
| R1 | 2000 ms | 1593 ms | 1877 ms | 2015 ms |
| R1C | 2000 ms | 1587 ms | 1854 ms | 2007 ms |
| G1 | 4000 ms | 3194 ms | 3715 ms | 4061 ms |
| G1C | 4000 ms | 3196 ms | 3382 ms | 4055 ms |
| R1 | 4000 ms | 3197 ms | 3629 ms | 4070 ms |
| R1C | 4000 ms | 3183 ms | 3255 ms | 3984 ms |
| G1 | 8000 ms | 6399 ms | 6847 ms | 5508 ms |
| G1C | 8000 ms | 6394 ms | 6221 ms | 6889 ms |
| R1 | 8000 ms | 6398 ms | 6169 ms | 6024 ms |
| R1C | 8000 ms | 6364 ms | 6183 ms | 7029 ms |
| G1 | 14000 ms | 12796 ms | 12793 ms | 8914 ms |
| G1C | 14000 ms | 12710 ms | 11334 ms | 11478 ms |
| R1 | 14000 ms | 12791 ms | 11410 ms | 7966 ms |
| R1C | 14000 ms | 12722 ms | 11154 ms | 11342 ms |
| G1 | 22000 ms | 17920 ms | 19770 ms | 19712 ms |
| G1C | 22000 ms | 17920 ms | 19815 ms | 19779 ms |
| R1 | 22000 ms | 25590 ms | 22701 ms | 13447 ms |
| R1C | 22000 ms | 17920 ms | 19840 ms | 19784 ms |

---

## juice-shop

Universe 24020 files / 270.5 MB; blob 75.6 MB in 17770 chunks (3721 shared). Frozen band 37 ms; eager arm's own worst post-admission window p99 184 ms.

### 1. The ladder — what a rung actually cost, and what it bought

| rung | arm | param | probe-measured prewarm | in-trial prewarm | manifest entries | resident files | resident MB | backend req @admit | backend MB @admit |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1.0 s | G1 | 800 | 983 ms | 982 ms | 198 | — | — | 169 | 38.0 |
| 1.0 s | G1C | 800 | 975 ms | 984 ms | 5906 | — | — | 156 | 38.9 |
| 1.0 s | R1 | 800 | 987 ms | 993 ms | 60 | — | — | 173 | 40.4 |
| 1.0 s | R1C | 800 | 983 ms | 989 ms | 5632 | — | — | 163 | 38.1 |
| 2.0 s | G1 | 1600 | 1623 ms | 2010 ms | 430 | — | — | 184 | 38.4 |
| 2.0 s | G1C | 1600 | 1620 ms | 2007 ms | 11302 | — | — | 167 | 34.2 |
| 2.0 s | R1 | 1600 | 1761 ms | 2012 ms | 143 | — | — | 207 | 41.7 |
| 2.0 s | R1C | 1600 | 1610 ms | 2010 ms | 10728 | — | — | 178 | 35.8 |
| 4.0 s | G1 | 3200 | 3201 ms | 2673 ms | 1082 | — | — | 245 | 36.0 |
| 4.0 s | G1C | 3200 | 3007 ms | 3274 ms | 16832 | — | — | 222 | 37.0 |
| 4.0 s | R1 | 3200 | 3051 ms | 2661 ms | 307 | — | — | 246 | 41.6 |
| 4.0 s | R1C | 3200 | 3009 ms | 3325 ms | 16904 | — | — | 243 | 38.9 |
| 6.0 s | G1 | 6400 | 6378 ms | 4060 ms | 3031 | — | — | 313 | 28.4 |
| 6.0 s | G1C | 6400 | 6126 ms | 6004 ms | 17731 | — | — | 338 | 69.8 |
| 6.0 s | R1 | 6400 | 5319 ms | 3693 ms | 692 | — | — | 298 | 38.6 |
| 6.0 s | R1C | 6400 | 6130 ms | 6008 ms | 17731 | — | — | 339 | 69.5 |
| 7.5 s | G1 | 25600 | 6673 ms | 6771 ms | 17733 | — | — | 333 | 76.6 |
| 7.5 s | G1C | 12800 | 6652 ms | 7483 ms | 17733 | — | — | 346 | 76.6 |
| 7.5 s | R1 | 25600 | 6801 ms | 6687 ms | 17733 | — | — | 342 | 76.4 |
| 7.5 s | R1C | 12800 | 6824 ms | 6732 ms | 17733 | — | — | 341 | 76.2 |

### 2. Equal measured prewarm time → outcome

`T_steady − T0` is the preregistered primary metric, computed against the frozen band.
`T_steady(eager) − T0` is the same construction against a REACHABLE threshold — the eager
arm's own worst cold post-admission window — because the frozen band comes from the eager
arm's WARM pass and no cold pass can meet it (experiment 4 amendment A4). Both are shown;
neither replaces the other. `T_traffic − T0` is admission delay.

| rung | arm | T_steady(eager)−T0 | reached | T_steady(band)−T0 | reached | T_traffic−T0 | max window p95 | max window p99 | post-adm remote req | residual prefetch | demand faults | post-adm MB |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1.0 s | G1 | 15799 | 4/4 | 15479 | 2/4 | 12112 | 82 | 340 | 24 | 0 | 24 | 4.0 |
| 1.0 s | G1C | 15295 | 4/4 | 15295 | 1/4 | 11654 | 82 | 382 | 21 | 0 | 21 | 5.3 |
| 1.0 s | R1 | 16510 | 4/4 | 16193 | 2/4 | 12453 | 127 | 352 | 25 | 0 | 25 | 4.6 |
| 1.0 s | R1C | 15553 | 4/4 | 15294 | 2/4 | 11952 | 96 | 360 | 20 | 0 | 20 | 6.4 |
| 2.0 s | G1 | 15859 | 4/4 | 14997 | 1/4 | 11980 | 98 | 420 | 26 | 0 | 26 | 4.9 |
| 2.0 s | G1C | 13251 | 4/4 | 13280 | 3/4 | 9474 | 104 | 354 | 20 | 0 | 20 | 6.3 |
| 2.0 s | R1 | 15585 | 4/4 | 15216 | 2/4 | 11923 | 127 | 348 | 22 | 0 | 22 | 4.5 |
| 2.0 s | R1C | 13871 | 4/4 | 15004 | 3/4 | 9750 | 139 | 350 | 18 | 0 | 18 | 6.5 |
| 4.0 s | G1 | 14642 | 4/4 | 15714 | 3/4 | 10579 | 108 | 460 | 24 | 0 | 24 | 7.3 |
| 4.0 s | G1C | 11725 | 4/4 | 11235 | 1/4 | 8212 | 132 | 274 | 8 | 0 | 8 | 4.6 |
| 4.0 s | R1 | 14413 | 4/4 | 14413 | 2/4 | 10834 | 117 | 351 | 21 | 0 | 21 | 3.9 |
| 4.0 s | R1C | 11325 | 4/4 | 11325 | 2/4 | 8204 | 69 | 290 | 7 | 0 | 7 | 3.9 |
| 6.0 s | G1 | 12235 | 4/4 | 11973 | 2/4 | 8125 | 82 | 453 | 25 | 0 | 25 | 7.5 |
| 6.0 s | G1C | 12158 | 4/4 | 12132 | 2/4 | 10124 | 45 | 158 | 0 | 0 | 0 | 0.0 |
| 6.0 s | R1 | 13905 | 4/4 | 13905 | 2/4 | 10370 | 127 | 438 | 22 | 0 | 22 | 4.7 |
| 6.0 s | R1C | 11988 | 4/4 | 12090 | 2/4 | 10050 | 43 | 162 | 0 | 0 | 0 | 0.0 |
| 7.5 s | G1 | 12561 | 4/4 | 12779 | 2/4 | 10394 | 44 | 160 | 0 | 0 | 0 | 0.0 |
| 7.5 s | G1C | 12304 | 4/4 | 13167 | 3/4 | 10387 | 45 | 158 | 0 | 0 | 0 | 0.0 |
| 7.5 s | R1 | 12221 | 4/4 | 12247 | 2/4 | 10277 | 45 | 160 | 0 | 0 | 0 | 0.0 |
| 7.5 s | R1C | 12617 | 4/4 | 12742 | 2/4 | 10395 | 46 | 169 | 0 | 0 | 0 | 0.0 |
| eager | E0 | 12603 | 4/4 | 12438 | 1/4 | 10445 | 46 | 171 | 0 | 0 | 0 | 0.0 |

### 3. Long-tail first-hit latency, arrival position 1 only


**admin-background**

| rung | G1 | G1C | R1 | R1C | E0 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1.0 s | — | — | — | — | — |
| 2.0 s | — | — | — | — | — |
| 4.0 s | — | — | — | — | — |
| 6.0 s | — | — | — | — | — |
| 7.5 s | — | — | — | — | — |

**error-path**

| rung | G1 | G1C | R1 | R1C | E0 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1.0 s | — | — | — | — | — |
| 2.0 s | — | — | — | — | — |
| 4.0 s | — | — | — | — | — |
| 6.0 s | — | — | — | — | — |
| 7.5 s | — | — | — | — | — |

**optional-feature**

| rung | G1 | G1C | R1 | R1C | E0 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1.0 s | 693 | 763 | 617 | 783 | 122 |
| 2.0 s | 684 | 843 | 522 | 591 | 122 |
| 4.0 s | 800 | 165 | 460 | 145 | 122 |
| 6.0 s | 1055 | 126 | 463 | 122 | 122 |
| 7.5 s | 127 | 124 | 126 | 136 | 122 |

**rare-route**

| rung | G1 | G1C | R1 | R1C | E0 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1.0 s | — | — | — | — | — |
| 2.0 s | — | — | — | — | — |
| 4.0 s | — | — | — | — | — |
| 6.0 s | — | — | — | — | — |
| 7.5 s | — | — | — | — | — |

**tenant-config**

| rung | G1 | G1C | R1 | R1C | E0 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1.0 s | 244 | 111 | 239 | 107 | 85 |
| 2.0 s | 269 | 112 | 288 | 105 | 85 |
| 4.0 s | 108 | 279 | 271 | 71 | 85 |
| 6.0 s | 269 | 74 | 363 | 75 | 85 |
| 7.5 s | 74 | 77 | 72 | 71 | 85 |

### 4. Equal outcome — smallest rung that is eager-matched

Eager-matched: median worst post-admission window p99 ≤ the worst the eager arm itself produced (experiment 4 amendment A4, reused).

| arm | smallest eager-matched rung | its measured prewarm |
| --- | --- | ---: |
| G1 | 7.5 s | 6673 ms |
| G1C | 6.0 s | 6126 ms |
| R1 | 7.5 s | 6801 ms |
| R1C | 6.0 s | 6130 ms |

### 5. Prewarm waste — resident at admission, never touched by any workload

| rung | arm | waste files | waste MB | needed TEST files still missing |
| ---: | --- | ---: | ---: | ---: |
| 1.0 s | G1 | — | — | — |
| 1.0 s | G1C | — | — | — |
| 1.0 s | R1 | — | — | — |
| 1.0 s | R1C | — | — | — |
| 2.0 s | G1 | — | — | — |
| 2.0 s | G1C | — | — | — |
| 2.0 s | R1 | — | — | — |
| 2.0 s | R1C | — | — | — |
| 4.0 s | G1 | — | — | — |
| 4.0 s | G1C | — | — | — |
| 4.0 s | R1 | — | — | — |
| 4.0 s | R1C | — | — | — |
| 6.0 s | G1 | — | — | — |
| 6.0 s | G1C | — | — | — |
| 6.0 s | R1 | — | — | — |
| 6.0 s | R1C | — | — | — |
| 7.5 s | G1 | — | — | — |
| 7.5 s | G1C | — | — | — |
| 7.5 s | R1 | — | — | — |
| 7.5 s | R1C | — | — | — |

### 6. The physical oracle — perfect future knowledge, priced in the same units

```text
needed TEST files       3340
unique chunks           3210
backend requests        681
backend bytes           8.4 MB
predicted prewarm       7425 ms
```

Against what a cost-aware arm actually pays for far more content:

| arm | rung | resident files | measured prewarm | backend requests |
| --- | ---: | ---: | ---: | ---: |
| G1C | 1.0 s | — | 975 ms | 56 |
| R1C | 1.0 s | — | 983 ms | 54 |
| G1C | 2.0 s | — | 1620 ms | 119 |
| R1C | 2.0 s | — | 1610 ms | 124 |
| G1C | 4.0 s | — | 3007 ms | 243 |
| R1C | 4.0 s | — | 3009 ms | 251 |
| G1C | 6.0 s | — | 6126 ms | 392 |
| R1C | 6.0 s | — | 6130 ms | 392 |
| G1C | 7.5 s | — | 6652 ms | 397 |
| R1C | 7.5 s | — | 6824 ms | 397 |

### 6b. Do the two prediction sources still disagree once both pay real retrieval cost?

Jaccard overlap of what each arm makes RESIDENT, from the frozen manifests alone — no trial, no latency.

| rung | G1C vs R1C: chunks | resident files | R1C-only | G1C-only | G1 vs R1: chunks | resident files |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1.0 s | 0.459 | 0.508 | 2742 | 2749 | 0.044 | 0.037 |
| 2.0 s | 0.768 | 0.791 | 1544 | 2166 | 0.073 | 0.058 |
| 4.0 s | 0.988 | 0.990 | 147 | 93 | 0.108 | 0.106 |
| 6.0 s | 1.000 | 1.000 | 0 | 0 | 0.112 | 0.119 |
| 7.5 s | 1.000 | 1.000 | 0 | 0 | 1.000 | 1.000 |

### 7. Why experiment 4 lost — its own manifests, re-priced physically

| exp-4 arm | byte budget | files | file MB | unique chunks | backend req | backend MB | overfetch | predicted prewarm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| G1 | 5% | 1932 | 13.5 | 1794 | 481 | 4.4 | 1.09× | 5275 ms |
| G1 | 10% | 2838 | 27.1 | 2630 | 498 | 6.1 | 1.07× | 5478 ms |
| G1 | 20% | 4035 | 54.1 | 3823 | 574 | 20.8 | 1.02× | 6501 ms |
| G1 | 40% | 7682 | 108.2 | 6233 | 551 | 30.2 | 1.01× | 6407 ms |
| G2 | 5% | 1932 | 13.5 | 1794 | 481 | 4.4 | 1.09× | 5275 ms |
| G2 | 10% | 4039 | 27.1 | 3489 | 640 | 6.2 | 1.09× | 6964 ms |
| G2 | 20% | 18015 | 54.1 | 13982 | 1163 | 16.0 | 1.03× | 12580 ms |
| G2 | 40% | 22474 | 108.2 | 16939 | 643 | 33.3 | 1× | 7416 ms |
| R1 | 5% | 12224 | 13.5 | 10403 | 1552 | 6.2 | 1.17× | 16490 ms |
| R1 | 10% | 14786 | 27.1 | 12724 | 1354 | 10.8 | 1.03× | 14493 ms |
| R1 | 20% | 16961 | 54.1 | 14713 | 862 | 20.8 | 1.01× | 9509 ms |
| R1 | 40% | 18392 | 108.2 | 15837 | 605 | 34.5 | 1× | 7038 ms |
| R2 | 5% | 1932 | 13.5 | 1794 | 481 | 4.4 | 1.09× | 5275 ms |
| R2 | 10% | 2907 | 27.1 | 2657 | 581 | 6.1 | 1.07× | 6345 ms |
| R2 | 20% | 15964 | 54.1 | 13718 | 1242 | 17.8 | 1.02× | 13433 ms |
| R2 | 40% | 18577 | 108.2 | 15898 | 597 | 34.2 | 1× | 6950 ms |

### 8. Correctness

```text
arm-vs-eager trial comparisons   80
status mismatches                0
body-length mismatches           0
body-fingerprint mismatches      0
declared-header mismatches       0
requests outside declared expect 0
```

### 9. Cost-model accuracy on the deployed manifests

| arm | rung | predicted | probe-measured | in-trial |
| --- | ---: | ---: | ---: | ---: |
| G1 | 1000 ms | 792 ms | 983 ms | 982 ms |
| G1C | 1000 ms | 800 ms | 975 ms | 984 ms |
| R1 | 1000 ms | 798 ms | 987 ms | 993 ms |
| R1C | 1000 ms | 798 ms | 983 ms | 989 ms |
| G1 | 2000 ms | 1592 ms | 1623 ms | 2010 ms |
| G1C | 2000 ms | 1587 ms | 1620 ms | 2007 ms |
| R1 | 2000 ms | 1593 ms | 1761 ms | 2012 ms |
| R1C | 2000 ms | 1597 ms | 1610 ms | 2010 ms |
| G1 | 4000 ms | 3194 ms | 3201 ms | 2673 ms |
| G1C | 4000 ms | 3171 ms | 3007 ms | 3274 ms |
| R1 | 4000 ms | 3193 ms | 3051 ms | 2661 ms |
| R1C | 4000 ms | 3180 ms | 3009 ms | 3325 ms |
| G1 | 6000 ms | 6398 ms | 6378 ms | 4060 ms |
| G1C | 6000 ms | 6316 ms | 6126 ms | 6004 ms |
| R1 | 6000 ms | 6394 ms | 5319 ms | 3693 ms |
| R1C | 6000 ms | 6316 ms | 6130 ms | 6008 ms |
| G1 | 7500 ms | 6497 ms | 6673 ms | 6771 ms |
| G1C | 7500 ms | 6497 ms | 6652 ms | 7483 ms |
| R1 | 7500 ms | 6497 ms | 6801 ms | 6687 ms |
| R1C | 7500 ms | 6497 ms | 6824 ms | 6732 ms |

---

## uptime-kuma

Universe 28851 files / 200.7 MB; blob 56.8 MB in 22315 chunks (3830 shared). Frozen band 7 ms; eager arm's own worst post-admission window p99 10 ms.

### 1. The ladder — what a rung actually cost, and what it bought

| rung | arm | param | probe-measured prewarm | in-trial prewarm | manifest entries | resident files | resident MB | backend req @admit | backend MB @admit |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1.0 s | G1 | 800 | 980 ms | 987 ms | 230 | — | — | 181 | 42.4 |
| 1.0 s | G1C | 800 | 841 ms | 997 ms | 7088 | — | — | 163 | 42.1 |
| 1.0 s | R1 | 800 | 987 ms | 992 ms | 61 | — | — | 204 | 42.0 |
| 1.0 s | R1C | 800 | 972 ms | 999 ms | 7112 | — | — | 178 | 41.8 |
| 2.0 s | G1 | 1600 | 1898 ms | 2028 ms | 623 | — | — | 210 | 41.5 |
| 2.0 s | G1C | 1600 | 1596 ms | 2031 ms | 13925 | — | — | 179 | 42.1 |
| 2.0 s | R1 | 1600 | 1621 ms | 2040 ms | 140 | — | — | 219 | 41.5 |
| 2.0 s | R1C | 1600 | 1720 ms | 2036 ms | 13696 | — | — | 189 | 42.0 |
| 3.0 s | G1 | 3200 | 3345 ms | 3081 ms | 1635 | — | — | 236 | 39.8 |
| 3.0 s | G1C | 3200 | 3141 ms | 3069 ms | 21504 | — | — | 228 | 40.4 |
| 3.0 s | R1 | 3200 | 2948 ms | 3082 ms | 303 | — | — | 249 | 40.9 |
| 3.0 s | R1C | 3200 | 3129 ms | 3088 ms | 21410 | — | — | 234 | 39.7 |
| 4.0 s | G1 | 3200 | 3345 ms | 2670 ms | 1635 | — | — | 240 | 39.8 |
| 4.0 s | G1C | 3200 | 3141 ms | 3214 ms | 21504 | — | — | 229 | 39.9 |
| 4.0 s | R1 | 3200 | 2948 ms | 2685 ms | 303 | — | — | 246 | 40.8 |
| 4.0 s | R1C | 3200 | 3129 ms | 3982 ms | 21410 | — | — | 232 | 40.7 |
| 5.6 s | G1 | 25600 | 5202 ms | 5655 ms | 22303 | — | — | 307 | 57.5 |
| 5.6 s | G1C | 51200 | 5223 ms | 5668 ms | 22303 | — | — | 306 | 57.7 |
| 5.6 s | R1 | 6400 | 5673 ms | 3988 ms | 720 | — | — | 320 | 41.1 |
| 5.6 s | R1C | 12800 | 5212 ms | 5582 ms | 22303 | — | — | 308 | 57.5 |

### 2. Equal measured prewarm time → outcome

`T_steady − T0` is the preregistered primary metric, computed against the frozen band.
`T_steady(eager) − T0` is the same construction against a REACHABLE threshold — the eager
arm's own worst cold post-admission window — because the frozen band comes from the eager
arm's WARM pass and no cold pass can meet it (experiment 4 amendment A4). Both are shown;
neither replaces the other. `T_traffic − T0` is admission delay.

| rung | arm | T_steady(eager)−T0 | reached | T_steady(band)−T0 | reached | T_traffic−T0 | max window p95 | max window p99 | post-adm remote req | residual prefetch | demand faults | post-adm MB |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1.0 s | G1 | 15589 | 4/4 | 16049 | 3/4 | 14706 | 7 | 125 | 2 | 0 | 2 | 2.1 |
| 1.0 s | G1C | 14044 | 2/4 | 14268 | 2/4 | 13443 | 7 | 130 | 2 | 0 | 2 | 2.1 |
| 1.0 s | R1 | 15500 | 4/4 | 16097 | 3/4 | 14708 | 6 | 131 | 2 | 0 | 2 | 2.1 |
| 1.0 s | R1C | 14842 | 4/4 | 15159 | 3/4 | 13888 | 7 | 125 | 2 | 0 | 2 | 2.1 |
| 2.0 s | G1 | 14615 | 4/4 | 14685 | 4/4 | 13760 | 7 | 125 | 2 | 0 | 2 | 2.1 |
| 2.0 s | G1C | 12937 | 4/4 | 13089 | 4/4 | 11974 | 7 | 125 | 2 | 0 | 2 | 2.1 |
| 2.0 s | R1 | 14257 | 4/4 | 14257 | 3/4 | 13288 | 7 | 124 | 2 | 0 | 2 | 2.1 |
| 2.0 s | R1C | 13435 | 4/4 | 13435 | 4/4 | 12290 | 7 | 127 | 2 | 0 | 2 | 2.1 |
| 3.0 s | G1 | 13259 | 4/4 | 13309 | 4/4 | 12266 | 7 | 126 | 2 | 0 | 2 | 2.1 |
| 3.0 s | G1C | 11215 | 3/4 | 11457 | 1/4 | 9949 | 7 | 130 | 2 | 0 | 2 | 2.1 |
| 3.0 s | R1 | 13450 | 4/4 | 13533 | 4/4 | 12512 | 7 | 129 | 2 | 0 | 2 | 2.1 |
| 3.0 s | R1C | 11763 | 3/4 | 10994 | 2/4 | 10157 | 7 | 165 | 3 | 0 | 3 | 3.1 |
| 4.0 s | G1 | 13321 | 4/4 | 13821 | 3/4 | 12439 | 7 | 125 | 2 | 0 | 2 | 2.1 |
| 4.0 s | G1C | 11068 | 4/4 | 11305 | 4/4 | 10092 | 7 | 156 | 2 | 0 | 2 | 2.1 |
| 4.0 s | R1 | 13294 | 4/4 | 13464 | 4/4 | 12425 | 6 | 125 | 2 | 0 | 2 | 2.1 |
| 4.0 s | R1C | 11410 | 4/4 | 11689 | 3/4 | 10296 | 7 | 170 | 2 | 0 | 2 | 2.1 |
| 5.6 s | G1 | 10948 | 3/4 | 11381 | 3/4 | 10447 | 6 | 8 | 0 | 0 | 0 | 0.0 |
| 5.6 s | G1C | 10881 | 4/4 | 11455 | 2/4 | 10491 | 6 | 8 | 0 | 0 | 0 | 0.0 |
| 5.6 s | R1 | 13082 | 4/4 | 13097 | 3/4 | 12244 | 7 | 124 | 2 | 0 | 2 | 2.1 |
| 5.6 s | R1C | 10917 | 4/4 | 11638 | 3/4 | 10520 | 7 | 10 | 0 | 0 | 0 | 0.0 |
| eager | E0 | 11135 | 4/4 | 12070 | 2/4 | 10764 | 6 | 9 | 0 | 0 | 0 | 0.0 |

### 3. Long-tail first-hit latency, arrival position 1 only


**error-path**

| rung | G1 | G1C | R1 | R1C | E0 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1.0 s | 6 | 7 | 5 | 6 | 5 |
| 2.0 s | 7 | 7 | 6 | 5 | 5 |
| 3.0 s | 5 | 5 | 6 | 6 | 5 |
| 4.0 s | 6 | 6 | 6 | 8 | 5 |
| 5.6 s | 5 | 7 | 7 | 4 | 5 |

**locale**

| rung | G1 | G1C | R1 | R1C | E0 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1.0 s | 228 | 234 | 234 | 232 | 10 |
| 2.0 s | 230 | 234 | 235 | 228 | 10 |
| 3.0 s | 232 | 237 | 230 | 250 | 10 |
| 4.0 s | 230 | 258 | 241 | 255 | 10 |
| 5.6 s | 8 | 9 | 233 | 9 | 10 |

**rare-route**

| rung | G1 | G1C | R1 | R1C | E0 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1.0 s | 7 | 5 | 6 | 4 | 5 |
| 2.0 s | 6 | 4 | 6 | 6 | 5 |
| 3.0 s | 6 | 5 | 5 | 6 | 5 |
| 4.0 s | 6 | 6 | 5 | 5 | 5 |
| 5.6 s | 6 | 6 | 6 | 6 | 5 |

### 4. Equal outcome — smallest rung that is eager-matched

Eager-matched: median worst post-admission window p99 ≤ the worst the eager arm itself produced (experiment 4 amendment A4, reused).

| arm | smallest eager-matched rung | its measured prewarm |
| --- | --- | ---: |
| G1 | 5.6 s | 5202 ms |
| G1C | 5.6 s | 5223 ms |
| R1 | never in the swept range | — |
| R1C | 5.6 s | 5212 ms |

### 5. Prewarm waste — resident at admission, never touched by any workload

| rung | arm | waste files | waste MB | needed TEST files still missing |
| ---: | --- | ---: | ---: | ---: |
| 1.0 s | G1 | — | — | — |
| 1.0 s | G1C | — | — | — |
| 1.0 s | R1 | — | — | — |
| 1.0 s | R1C | — | — | — |
| 2.0 s | G1 | — | — | — |
| 2.0 s | G1C | — | — | — |
| 2.0 s | R1 | — | — | — |
| 2.0 s | R1C | — | — | — |
| 3.0 s | G1 | — | — | — |
| 3.0 s | G1C | — | — | — |
| 3.0 s | R1 | — | — | — |
| 3.0 s | R1C | — | — | — |
| 4.0 s | G1 | — | — | — |
| 4.0 s | G1C | — | — | — |
| 4.0 s | R1 | — | — | — |
| 4.0 s | R1C | — | — | — |
| 5.6 s | G1 | — | — | — |
| 5.6 s | G1C | — | — | — |
| 5.6 s | R1 | — | — | — |
| 5.6 s | R1C | — | — | — |

### 6. The physical oracle — perfect future knowledge, priced in the same units

```text
needed TEST files       4287
unique chunks           3886
backend requests        740
backend bytes           9.0 MB
predicted prewarm       8052 ms
```

Against what a cost-aware arm actually pays for far more content:

| arm | rung | resident files | measured prewarm | backend requests |
| --- | ---: | ---: | ---: | ---: |
| G1C | 1.0 s | — | 841 ms | 55 |
| R1C | 1.0 s | — | 972 ms | 57 |
| G1C | 2.0 s | — | 1596 ms | 126 |
| R1C | 2.0 s | — | 1720 ms | 121 |
| G1C | 3.0 s | — | 3141 ms | 247 |
| R1C | 3.0 s | — | 3129 ms | 251 |
| G1C | 4.0 s | — | 3141 ms | 247 |
| R1C | 4.0 s | — | 3129 ms | 251 |
| G1C | 5.6 s | — | 5223 ms | 361 |
| R1C | 5.6 s | — | 5212 ms | 361 |

### 6b. Do the two prediction sources still disagree once both pay real retrieval cost?

Jaccard overlap of what each arm makes RESIDENT, from the frozen manifests alone — no trial, no latency.

| rung | G1C vs R1C: chunks | resident files | R1C-only | G1C-only | G1 vs R1: chunks | resident files |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1.0 s | 0.455 | 0.532 | 2962 | 3123 | 0.028 | 0.016 |
| 2.0 s | 0.748 | 0.767 | 2221 | 2784 | 0.030 | 0.019 |
| 3.0 s | 0.977 | 0.981 | 224 | 308 | 0.071 | 0.058 |
| 4.0 s | 0.977 | 0.981 | 224 | 308 | 0.071 | 0.058 |
| 5.6 s | 1.000 | 1.000 | 0 | 0 | 0.032 | 0.041 |

### 7. Why experiment 4 lost — its own manifests, re-priced physically

| exp-4 arm | byte budget | files | file MB | unique chunks | backend req | backend MB | overfetch | predicted prewarm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| G1 | 5% | 2007 | 10.0 | 1621 | 284 | 2.8 | 1.07× | 3192 ms |
| G1 | 10% | 3652 | 20.1 | 3240 | 623 | 6.1 | 1.12× | 6785 ms |
| G1 | 20% | 4665 | 40.1 | 4232 | 789 | 16.1 | 1.05× | 8674 ms |
| G1 | 40% | 11844 | 80.3 | 9403 | 739 | 24.3 | 1.03× | 8279 ms |
| G2 | 5% | 2009 | 10.0 | 1621 | 283 | 2.8 | 1.07× | 3181 ms |
| G2 | 10% | 3652 | 20.1 | 3240 | 622 | 6.1 | 1.12× | 6774 ms |
| G2 | 20% | 16984 | 40.1 | 13302 | 1343 | 13.2 | 1.05× | 14416 ms |
| G2 | 40% | 24678 | 80.3 | 19088 | 937 | 25.5 | 1.02× | 10367 ms |
| R1 | 5% | 14342 | 10.0 | 11019 | 1654 | 5.4 | 1.35× | 17543 ms |
| R1 | 10% | 18227 | 20.1 | 14169 | 1663 | 7.9 | 1.12× | 17676 ms |
| R1 | 20% | 21914 | 40.1 | 17243 | 1255 | 12.8 | 1.03× | 13491 ms |
| R1 | 40% | 25151 | 80.3 | 19907 | 701 | 25.0 | 1.01× | 7892 ms |
| R2 | 5% | 2011 | 10.0 | 1621 | 284 | 2.8 | 1.07× | 3192 ms |
| R2 | 10% | 3654 | 20.1 | 3240 | 623 | 6.1 | 1.12× | 6785 ms |
| R2 | 20% | 19396 | 40.1 | 15146 | 1613 | 13.8 | 1.11× | 17246 ms |
| R2 | 40% | 25346 | 80.3 | 20053 | 731 | 23.6 | 1× | 8184 ms |

### 8. Correctness

```text
arm-vs-eager trial comparisons   80
status mismatches                0
body-length mismatches           0
body-fingerprint mismatches      0
declared-header mismatches       0
requests outside declared expect 0
```

### 9. Cost-model accuracy on the deployed manifests

| arm | rung | predicted | probe-measured | in-trial |
| --- | ---: | ---: | ---: | ---: |
| G1 | 1000 ms | 791 ms | 980 ms | 987 ms |
| G1C | 1000 ms | 799 ms | 841 ms | 997 ms |
| R1 | 1000 ms | 798 ms | 987 ms | 992 ms |
| R1C | 1000 ms | 799 ms | 972 ms | 999 ms |
| G1 | 2000 ms | 1593 ms | 1898 ms | 2028 ms |
| G1C | 2000 ms | 1592 ms | 1596 ms | 2031 ms |
| R1 | 2000 ms | 1593 ms | 1621 ms | 2040 ms |
| R1C | 2000 ms | 1590 ms | 1720 ms | 2036 ms |
| G1 | 3000 ms | 3193 ms | 3345 ms | 3081 ms |
| G1C | 3000 ms | 3196 ms | 3141 ms | 3069 ms |
| R1 | 3000 ms | 3193 ms | 2948 ms | 3082 ms |
| R1C | 3000 ms | 3197 ms | 3129 ms | 3088 ms |
| G1 | 4000 ms | 3193 ms | 3345 ms | 2670 ms |
| G1C | 4000 ms | 3196 ms | 3141 ms | 3214 ms |
| R1 | 4000 ms | 3193 ms | 2948 ms | 2685 ms |
| R1C | 4000 ms | 3197 ms | 3129 ms | 3982 ms |
| G1 | 5600 ms | 5547 ms | 5202 ms | 5655 ms |
| G1C | 5600 ms | 5547 ms | 5223 ms | 5668 ms |
| R1 | 5600 ms | 6395 ms | 5673 ms | 3988 ms |
| R1C | 5600 ms | 5547 ms | 5212 ms | 5582 ms |
