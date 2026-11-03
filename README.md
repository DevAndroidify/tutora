# Tutora backend

Backend for a skills marketplace: learners post what they want to learn (any skill, from Class 12
maths to stock-market basics or video editing), verified tutors place sealed bids, and the accepted
tutor teaches a paid live session. First market: India.

There are three client apps, each with its own API area and tokens: **student**, **tutor** and
**admin** (staff portal), plus unauthenticated **public** browsing. One member account works in both
the student and tutor apps.

Architecture and build plan: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** (v2; replaces the
academic-only plan in `CLAUDE_CODE_BACKEND_BUILD.md`).
**All 21 build parts (0-20) are done.** Measured results: [docs/RESULTS.md](docs/RESULTS.md).
Security review: [docs/SECURITY.md](docs/SECURITY.md). OpenAPI per app: `docs/openapi/*.json`.

## Résumé summary

Designed and built the backend of a skills-tutoring marketplace (India, UPI) as a NestJS/TypeScript
modular monolith with separate student, tutor and admin APIs: sealed-bid matching with Socket.IO
updates through a transactional outbox, race-safe booking (50 concurrent accepts → exactly one
booking), a double-entry append-only ledger with escrow-style holds, UPI payments via Razorpay (test
mode) with signed, deduplicated webhooks, LiveKit live sessions with consent-gated recording,
transcripts with full-text replay search, trust & safety moderation, outcome-based tutor scores, and
pgvector similarity pooling for group sessions. 179 integration tests on real PostgreSQL/Redis; k6:
300 bids at p95 193 ms, webhook ingestion p95 44 ms; Prometheus metrics and OpenTelemetry tracing.

## Architecture

```
 Student app      Tutor app      Admin portal        LiveKit       Razorpay / UPI simulator
     │ aud=student    │ aud=tutor     │ aud=admin          │ webhooks       │ webhooks
 ┌───▼────────────────▼───────────────▼────────────────────▼────────────────▼───────────┐
 │ API (NestJS)   /student  /tutor  /admin  /public  /webhooks  /metrics  /realtime (WS) │
 │ apps/      routes + DTOs per client app                                               │
 │ modules/   identity · catalog · tutors · moderation · requests · bidding · sessions   │
 │            payments · ledger · settlement · live · recording · replay · mastery       │
 │            lowbandwidth · pooling · group-booking · notifications · realtime          │
 │ platform/  config · db · redis · outbox · storage · audit · idempotency · telemetry   │
 │ providers/ upi (fake, razorpay) · livekit · screening · transcription · embeddings     │
 └──────┬──────────────────────────────────────────────────────────────────┬────────────┘
        │ state + outbox rows (one transaction)                             │ BullMQ jobs
 ┌──────▼──────────────┐   ┌───────────┐  ┌──────────┐  ┌────────────────▼─────────────┐
 │ PostgreSQL          │   │ Redis      │  │ MinIO/S3 │  │ Worker: outbox → sockets,     │
 │ (+pgvector,pg_trgm) │   │ (rebuild-  │  │ (private,│  │ notifications, transcription, │
 │ source of truth     │   │  able only)│  │ presigned│  │ pooling; sweeps for expiry,   │
 └─────────────────────┘   └───────────┘  └──────────┘  │ release, no-shows, refunds    │
                                                         └──────────────────────────────┘
```

- **Modular monolith, two processes.** Modules own their tables and talk through exported services.
- **Every state change is a guarded update** (`WHERE status = …`; no row → `409`) and writes its
  outbox event in the same transaction. REST changes state; WebSockets only announce saved changes.
- **Money:** integer paise, double-entry ledger (gateway_clearing, held_funds, tutor_payable,
  platform_revenue, payout_clearing), held until the dispute window ends.
- **Time:** all logic reads an injectable `Clock`; tests fast-forward it. Every delayed job has a sweep.

## Stack

NestJS 12 (Express, `rawBody: true`) · TypeScript strict · PostgreSQL 17 + pgvector + pg_trgm ·
Drizzle ORM and Drizzle Kit · Redis + BullMQ · S3 API (MinIO-compatible locally) · LiveKit · Zod
settings · class-validator DTOs · Argon2id · Pino logs with request IDs · Jest + Supertest against
real PostgreSQL and Redis · Swagger per app (not in production).

## Requirements

- **Node.js 24.9 or later** (`.nvmrc` says `24`). NestJS 12 ships as ES modules; Jest can only
  `require()` them on Node 24.9+.
- **Yarn 4** via Corepack: `corepack enable`.
- Docker with Compose v2.

## Setup

```bash
nvm use                      # Node 24
corepack enable              # provides yarn 4.9.2 (pinned in package.json)
yarn install
cp .env.example .env         # then set real local values; see "Settings" below
docker compose up -d --wait  # PostgreSQL, Redis, MinIO-compatible storage, LiveKit (dev mode)
yarn db:migrate              # migrate the development database
yarn db:seed                 # storage bucket, first staff admin, starter skill catalog
yarn dev:all                 # API on :3000 and the worker, with reload
```

Check it:

```bash
curl http://localhost:3000/health
open http://localhost:3000/docs/student   # also /docs/tutor, /docs/admin, /docs/public
```

For the local compose services, `.env` needs `S3_SECRET_ACCESS_KEY=tutora-dev-secret` and
`LIVEKIT_API_SECRET=secret` (LiveKit `--dev` keys). Generate `JWT_ACCESS_SECRET` with
`openssl rand -hex 32`. The seeded admin signs in at `POST /admin/auth/login` with
`ADMIN_EMAIL` / `ADMIN_PASSWORD`.

## Scripts

| Script | What it does |
| --- | --- |
| `yarn dev` / `yarn dev:worker` / `yarn dev:all` | API, worker, or both, in watch mode. The worker publishes realtime events and runs expiry sweeps, so run both. |
| `yarn build` then `yarn start` / `yarn start:worker` | Compiled API / worker |
| `yarn lint` / `yarn typecheck` | ESLint / `tsc --noEmit` |
| `yarn test` | All unit and integration tests (needs `docker compose up`) |
| `yarn db:generate` | Generate a migration from schema changes |
| `yarn db:migrate` | Apply migrations to `DATABASE_URL` |
| `yarn db:migrate:test` | Apply migrations to the test database |
| `yarn db:seed` | Idempotent seed: bucket, first staff admin, starter skill catalog |
| `yarn ledger:report` | Print every ledger account balance and the reconciliation check |
| `yarn pool:evaluate` | Precision/recall of the pooling similarity threshold on a labelled fixture |
| `yarn demo` | End-to-end demo against a running API + worker, ending with a ledger report |
| `yarn load:setup && yarn load:run` | k6 load tests (bid creation, acceptance, webhooks) via Docker; reports in `docs/load/` |
| `yarn openapi:export` | Write and check `docs/openapi/{student,tutor,admin,public}.json` |
| `docker build -t tutora .` | Production image (API by default; worker: `node dist/app/worker.main.js`; migrations: `node dist/scripts/migrate.js`) |

## Databases and test isolation

- Development: `tutora` database, Redis DB 0, bucket `tutora-dev`.
- Tests: `tutora_test` database, Redis DB 1, bucket `tutora-test` (from `.env.test`).
  The test run migrates `tutora_test` first, refuses to run against a database without `_test`
  in its name, and empties every table before each test.

Both databases are created by `docker/postgres/init/01-databases.sql` on first start. To reset
everything: `docker compose down -v && docker compose up -d --wait`.

## Settings

All settings are validated with Zod at startup (`src/platform/config/env.schema.ts`). An invalid
or missing setting stops the API or worker with a message listing every problem. Every setting is
in `.env.example` with a safe placeholder.

## Layout

```text
src/
  app/          api.main.ts, worker.main.ts, module wiring, configure-app.ts (per-app Swagger)
  apps/         one folder per client app: routes and DTOs only
    student/    /student/*
    tutor/      /tutor/*
    admin/      /admin/*  (staff only)
    public/     /public/* (no sign-in)
  modules/      data + business rules: identity, catalog, tutors, moderation, requests, bidding,
                notifications, realtime (+ folders for later parts)
  platform/     config, clock, database, errors, http, health, redis, queue, storage,
                telemetry (logging), audit, idempotency, rate-limit
  providers/    livekit (+ folders for later parts)
  scripts/      migrate.ts, seed.ts
drizzle/        SQL migrations, one set per part
docs/           ARCHITECTURE.md
test/           integration tests and fixtures
```

Rules: `apps` call modules' exported services; modules never import from `apps`; a module only
queries its own tables. State changes use guarded `UPDATE ... WHERE status = ...` and return `409`
when no row changes. All time comes from the injectable `Clock` (tests use `FakeClock`).

## API so far

| App | Method and path | Who | Notes |
| --- | --- | --- | --- |
| — | `GET /health` | anyone | `200` when PostgreSQL, Redis, storage and LiveKit are up; `503` naming what is down |
| student | `POST /student/auth/register\|login\|refresh\|logout` | public | Member sign-up / sign-in for the learner app |
| student | `GET /student/me` | member | |
| tutor | `POST /tutor/auth/register\|login\|refresh\|logout` | public | Same accounts as the student app, separate tokens |
| tutor | `GET /tutor/me` | member | Includes tutor-profile status |
| tutor | `GET/PUT /tutor/profile` | member | Become a tutor / edit profile (private payout UPI) |
| tutor | `POST /tutor/profile/verification` | member | Submit for staff review |
| tutor | `PUT/DELETE /tutor/skills/:skillId` | member | Claim a skill with evidence links; each claim is reviewed |
| tutor | `GET/POST /tutor/skill-suggestions` | member | Suggest a skill missing from the catalog |
| admin | `POST /admin/auth/login\|refresh\|logout` | staff | No sign-up; staff are seeded or created by admins |
| admin | `GET /admin/me` | staff | |
| admin | `GET /admin/tutors/profile-reviews`, `GET /admin/tutors/skill-reviews` | ADMIN | Review queues |
| admin | `POST /admin/tutors/:userId/verification/approve\|reject` | ADMIN | Audited |
| admin | `POST /admin/tutors/:userId/skills/:skillId/approve\|reject` | ADMIN | Audited |
| admin | `GET/POST/PATCH /admin/catalog/categories…`, `…/skills…`, `POST …/skills/:id/topics` | ADMIN | Manage the catalog; audited |
| admin | `GET /admin/catalog/skill-suggestions`, `POST …/:id/approve\|reject` | ADMIN | Approving creates the skill; audited |
| public | `GET /public/categories`, `GET /public/skills?q=&categoryId=`, `GET /public/skills/:idOrSlug` | anyone | Catalog browsing and search |
| public | `GET /public/tutors?skillId=`, `GET /public/tutors/:userId` | anyone | Verified tutors, approved skills only |
| student | `POST/GET /student/requests`, `GET/PATCH /student/requests/:id` | member | Learning requests (drafts editable; text screened) |
| student | `POST /student/requests/:id/publish|cancel` | member | DRAFT→OPEN (expires after `REQUEST_TTL_HOURS`); cancel expires open bids |
| student | `POST /student/uploads/presign`, `POST /student/requests/:id/attachments` | member | Direct upload to storage (PNG/JPEG/WebP/PDF), then attach |
| student | `GET /student/requests/:id/bids?sort=score|price|time` | owner | All bids with prices and score explanation |
| tutor | `GET /tutor/requests`, `GET /tutor/requests/:id` | verified tutor | Open requests in approved skills; bid count and own bid only |
| tutor | `POST /tutor/requests/:id/bids`, `GET /tutor/bids`, `PATCH /tutor/bids/:id`, `POST /tutor/bids/:id/withdraw` | verified tutor | Sealed bids; one active bid per request |
| tutor | `POST /tutor/uploads/presign` | member | Short intro video/audio for a bid |
| both | `POST /{student,tutor}/reports` | member | Report a member (harassment, off-platform payment, stock tips, …) |
| both | `GET /{student,tutor}/notifications`, `POST …/:id/read` | member | In-app notifications |
| admin | `GET/POST /admin/moderation/cases`, `GET …/cases/:id`, `POST …/cases/:id/assign|actions` | ADMIN, MODERATOR | Trust & safety queue and decisions; audited |
| admin | `GET /admin/moderation/users/:userId/sanctions`, `POST /admin/moderation/sanctions/:id/lift` | ADMIN, MODERATOR | Sanction history; lift early |

| student | `POST /student/bids/:id/accept` | owner | Reserve the tutor; payment window starts (`PAYMENT_WINDOW_MINUTES`) |
| student | `GET /student/sessions` · tutor `GET /tutor/sessions` | member | Bookings |
| student | `POST /student/participants/:id/payments` (needs `Idempotency-Key`) | owner | Create a UPI order; returns order id, amount, currency, public checkout config |
| student | `GET /student/payments/:id`, `POST /student/payments/:id/confirm` | owner | Status; Razorpay checkout callback (signature + server-side check) |
| — | `POST /webhooks/:provider` | provider | `fake` or `razorpay`; raw-body signature check, saved then processed by the worker |
| — | `POST /dev/fake-upi/orders/:orderId/pay`, `GET /dev/razorpay-checkout` | dev only | UPI simulator and a Razorpay test checkout page (404 in production) |
| admin | `GET /admin/payments`, `GET /admin/ledger/balances`, `GET /admin/ledger/reconciliation` | ADMIN | Money overview |

| both | `POST /{student,tutor}/sessions/:id/join-token` | tutor / paid learner | Short-lived LiveKit token for room `session-<id>` |
| both | `GET /{student,tutor}/sessions/:id/attendance` | session members | Time in room, from LiveKit events |
| both | `POST /{student,tutor}/sessions/:id/consent`, `GET …/recording` | session members | Recording consent; playback URL when ready |
| student | `POST /student/sessions/:id/disputes`, `POST /student/sessions/:id/review` | attendee | Dispute within `DISPUTE_WINDOW_HOURS` (freezes money); rate the tutor |
| student | `GET /student/quizzes`, `POST /student/quizzes/:id/submit` | learner | Exit quiz and 7-day recheck (no answer keys) |
| tutor | `GET /tutor/earnings` | tutor | Available, pending, released, payouts |
| — | `POST /webhooks/livekit` | LiveKit | Signed room / participant / egress events |
| admin | `GET /admin/disputes`, `POST /admin/disputes/:id/resolve` | ADMIN | RELEASE or REFUND; audited |
| admin | `POST /admin/payments/:id/release\|refund`, `POST /admin/payouts`, `GET /admin/reconciliation` | ADMIN | Money actions and ledger/provider reconciliation |
| admin | `GET /admin/sessions/:id/attendance`, `GET /admin/sessions/:id/recording` | ADMIN | Recording only while a dispute is open; audited |

| both | `GET /{student,tutor}/sessions/:id/replay`, `GET …/replay/search?q=` | session members | Recording, transcript, notes, flashcards, whiteboards; search within one session |
| tutor | `PUT /tutor/sessions/:id/notes` | session tutor | Tutor-written notes (shown instead of generated) |
| both | `POST /{student,tutor}/sessions/:id/mode-events` | tutor / paid learner | FULL_VIDEO, AUDIO_ONLY, WHITEBOARD_ONLY |
| both | `POST /{student,tutor}/sessions/:id/whiteboard-snapshots/presign`, `POST …/whiteboard-snapshots` | tutor / paid learner | PNG/WebP up to 2 MB, `WHITEBOARD_SNAPSHOT_LIMIT` per person |
| student | `GET /student/pools/invites`, `POST …/invites/:id/accept\|decline` | learner | Opt-in group sessions; other learners stay anonymous |
| admin | `GET /admin/metrics/low-bandwidth?from=&to=` | ADMIN | Share of sessions using low-bandwidth modes |
| tutor | `GET /tutor/pools`, `POST /tutor/pools/:id/bids` | verified tutor | Group bids: seat price, `minSeats`, `maxSeats` (≤ `POOL_MAX_SEATS`) |
| student | `GET /student/pools/:id/bids`, `POST /student/pools/:id/bids/:bidId/accept` | pool member | Accept the group offer; then pay your own seat |
| — | `GET /metrics` | Prometheus | Off in production unless `METRICS_TOKEN` is set |
| dev | `GET /dev/livekit-room` | dev only | Join a room from two tabs; switch modes; auto audio-only on poor connection |

**Realtime:** Socket.IO namespace `/realtime`, connect with `auth: { token: <access token> }`.
You join your own user room automatically; emit `subscribe` with `{ room: "request:<id>:owner" }`
(learner) or `"request:<id>:tutors"` (eligible tutor). Events: `bid.created`, `bid.updated`,
`bid.withdrawn` (owner and the bidder only), `request.bid_count_changed` (tutors room: count only),
`request.closed`, `notification.created`, `moderation.case_updated` (admin).

Errors always look like:

```json
{ "error": { "code": "TOKEN_APP_MISMATCH", "message": "...", "details": {}, "requestId": "req_..." } }
```

### Reusable building blocks for later parts

- `@ForApp('student' | 'tutor' | 'admin')` on every controller; routes are private by default and
  need a token issued to that app. `@Public()` opts out.
- `@StaffRoles('ADMIN', 'MODERATOR')`: admin-app permissions, `403 FORBIDDEN_ROLE`.
- `assertOwnership(user, ownerId, { allowStaff })`: `403 NOT_OWNER`.
- `@Idempotent()`: requires `Idempotency-Key`, replays the saved response for the same body,
  `409 IDEMPOTENCY_KEY_REUSED` for a different body, `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` while
  the first is running. A failed request releases its key so the client can retry.
- `@RateLimit('login')`: named Redis rate-limit policies (per app, IP and email).
- `@UseGuards(VerifiedTutorGuard)` and `TutorsService.canTeach(userId, skillId)`.
- `AuditService.record(entry, tx)`: append-only `audit_log`, written in the caller's transaction.
- `ModerationService.screen()/screenFields()` on any user-written text; `assertCanPost/assertCanBid`.
- `OutboxService.add(tx, type, payload)`: events commit with the change; the worker delivers them.
- `UploadsService.presign/verify/readUrl`: typed, size-limited, per-user upload keys.

## Payments (test mode only)

- Money is stored as integer paise (`bigint`), currency INR. Every money movement is a balanced,
  append-only ledger transaction (`gateway_clearing`, `held_funds`, `tutor_payable:{id}`,
  `platform_revenue`, `payout_clearing`). A deferred database trigger rejects unbalanced commits.
- Default `UPI_PROVIDER=fake`: a local simulator. Pay any order with
  `POST /dev/fake-upi/orders/{orderId}/pay` (optionally `{"amountPaise": n}` or `{"fail": true}`).
- Late or wrong-amount payments are refunded automatically and staff are alerted (audit log +
  `payments.alert` on the admin socket room).
- **Razorpay test mode:** set `UPI_PROVIDER=razorpay` plus `RAZORPAY_KEY_ID` (must start with
  `rzp_test_`; live keys stop startup), `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` from the
  Razorpay Dashboard in **Test Mode**. Open `http://localhost:3000/dev/razorpay-checkout`, paste a
  student token and participant id, and pay with Razorpay's test UPI flow. For webhooks, expose the API
  with a tunnel Razorpay allows (e.g. `zrok share public localhost:3000`, not ngrok) and add
  `https://<tunnel>/webhooks/razorpay` in Test Mode webhooks with events `payment.captured`,
  `order.paid`, `payment.failed`, `refund.processed`, `refund.failed`. UPI Collect is hidden
  (deprecated); desktop shows a QR, mobile uses Intent.

## Sessions, settlement and recording

- LiveKit runs from `docker/livekit/livekit.yaml` (dev keys, Redis, webhooks to
  `http://host.docker.internal:3000/webhooks/livekit`). First join sets the session LIVE; the room
  finishing sets it ENDED, learners become ATTENDED/ABSENT, and exit quizzes are created.
- Held money is released `DISPUTE_WINDOW_HOURS` after the session ends (minus `PLATFORM_FEE_BPS`).
  If the tutor is not in the room `NO_SHOW_GRACE_MINUTES` after start, the learner is refunded in full
  and the request reopens. A dispute freezes the money until an admin decides.
- `HOLD_MODE=ledger_only` (default) keeps holds in the ledger and payouts are recorded manually.
  `HOLD_MODE=razorpay_route` (off by default) puts the tutor share on hold in a Razorpay Route
  transfer and releases it later. **Route needs Razorpay approval for your business account** and
  each tutor needs a linked account. The platform never holds customer money in its own wallet.
- Mastery Score = (weightedPasses + k·platformAverage) / (weightedAttempts + k), exit = 1, recheck = 2,
  k = `MASTERY_K`; shown as "New tutor" until `MASTERY_MIN_ATTEMPTS`. Skills without a question bank
  use a 1-5 self-check. Quiz results never affect payments. The score feeds bid ranking (M).
- Recording starts only when the tutor and every paid learner consent. Egress (headless Chrome) is
  optional: `docker compose --profile recording up -d`. Files expire after `RECORDING_RETENTION_DAYS`.

## Replay and pooling

- When a recording completes, an outbox event queues transcription; a finished transcript queues notes and
  flashcards as separate jobs. Each step retries safely and a failure leaves the rest usable.
- Transcription, notes/flashcards and embeddings use **deterministic fake providers only**. Choosing real
  providers (cost, Indian languages, data residency) is still your decision. Generated text is treated as
  data: markup and control characters are stripped and only the expected fields are stored.
- Pooling embeds each published request (pgvector, HNSW cosine index) and invites open requests with the
  same skill and level above `POOL_SIMILARITY_THRESHOLD`. If embeddings fail it falls back to the same topic.
  Learners join only by accepting.

## Group sessions and operations

- Group offers: the first member to accept fixes the offer and starts `POOL_PAYMENT_WINDOW_MINUTES`.
  Each member pays separately; the session is scheduled once `minSeats` have paid and no more than
  `maxSeats` can pay (payments lock the session row). Below `minSeats` at the deadline everyone is
  refunded, the pool expires and every request reopens.
- Observability: Prometheus at `/metrics` (HTTP latency, bid delivery p95, acceptance conflicts,
  reconciliation mismatches, completion and no-show rates, low-bandwidth share, pool acceptance, quiz
  pass rate). OpenTelemetry traces with `OTEL_ENABLED=true` and an OTLP endpoint.
- HTTP: `helmet` headers, CORS allow-list via `CORS_ORIGINS`.

## Notes and decisions

- **MinIO image.** MinIO stopped publishing images (Docker Hub and quay.io stopped serving them in
  September 2026). `compose.yaml` uses `pgsty/silo`, a community fork of MinIO with the same S3 API
  and admin console (`:9001`). The service is still named `minio`. The app only uses the S3 API, so
  any S3-compatible store works. Buckets are created by `yarn db:seed` and the test setup.
- **Node 24 + Jest.** `yarn test` runs Jest with `--experimental-vm-modules`, which Jest needs to
  load NestJS 12's ES modules from the CommonJS test files.
- **audit_log** is append-only: a trigger blocks `UPDATE` and `DELETE`.
- Refresh tokens are 48 random bytes, stored only as SHA-256 hashes, and bound to one app.
- Finance skills carry a learner notice ("education only, not investment advice"). See the open
  risks in `docs/ARCHITECTURE.md` (minimum age, SEBI, recording policy).
