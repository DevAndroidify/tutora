# Results

Every number here was measured on the development machine (WSL2 Ubuntu on Windows 11, Docker
Compose services, Node 24.22, one API process, one worker process) on 2026-11-03. Nothing is
estimated. Re-run with the commands shown; raw k6 output is in `docs/load/`.

## Automated tests

| What | Result |
| --- | --- |
| Integration + unit tests (`yarn test`) | **23 suites, 179 tests, all passing** (100 s), against real PostgreSQL, Redis, MinIO and LiveKit |
| Clean checkout (copy without `node_modules`/`dist`, `yarn install --immutable`, typecheck, test) | install OK, typecheck OK, **179/179 tests** (129 s); lint found one issue, since fixed and re-run clean |
| Concurrency: 50 simultaneous accepts of bids on one request (test) | exactly **1** reservation, **49** × `409` |
| Concurrency: 20 simultaneous payment captures for a 3-seat group (test) | exactly **3** seats confirmed, **2** refunded |
| Ledger: 150 randomized postings + payouts (test) | debits = credits, assets = liabilities + revenue |
| Authorization sweep: every documented private route called without a token (test) | all return `401` |

## Load tests (k6 2.2.0, `yarn load:setup && yarn load:run`)

| Scenario | Load | Result |
| --- | --- | --- |
| Bid creation (`k6/bid-create.js`) | 300 bids, 20 VUs | **300/300 created**, 0 failed; p95 **193 ms**, median 125 ms, max 208 ms; 156 req/s |
| Bid acceptance under contention (`k6/bid-accept.js`) | 20 requests × 5 bids, all 100 accepts at once | **20 winners, 80 refused with 409, 0 unexpected**; p95 **245 ms**, max 249 ms |
| Webhook ingestion (`k6/webhooks.js`) | 500 signed webhooks, each sent twice, 25 VUs | **1000/1000 answered 200**, all **500 duplicates detected**; p95 **44 ms**, max **165 ms** (Razorpay needs < 5 s) |

## Metrics observed after the load run (`GET /metrics`)

| Metric | Value |
| --- | --- |
| `tutora_bid_delivery_p95_seconds` (bid saved → realtime event published, last hour) | **0.463 s** |
| `tutora_acceptance_conflicts_prevented_total` | **80** (the 80 refused accepts above) |
| `tutora_reconciliation_mismatches` | **0** |

The other business metrics (`session_completion_ratio`, `tutor_no_show_rate`, `low_bandwidth_share`,
`pool_invite_acceptance_ratio`, `quiz_pass_rate`) were exported but are based on a handful of demo
sessions, so they are not meaningful yet and are not reported as results.

## Production image

| Check | Result |
| --- | --- |
| `docker build -t tutora:local .` | builds; image **633 MB** |
| Migrations, API and worker from the image | migrations applied; `/health` 200; worker running as user `node` |
| Production behaviour | `/docs/*` 404, `/dev/*` 404, live Razorpay key refused at startup |

## End-to-end demo (`yarn demo`)

Registration → tutor verification → request (phone number hidden) → sealed bid → accept → UPI payment
(simulator) → live session (signed LiveKit webhooks) → exit quiz and review → release (₹499: tutor
₹449.10, platform ₹49.90) → payout recorded → reconciliation **OK, 0 mismatches**.

## Not measured

- Real video calls, real recordings (Egress) and real Razorpay test-mode traffic were not part of
  these runs; they need browsers and your Razorpay test keys.
- No multi-instance or production-hardware load test was run.
