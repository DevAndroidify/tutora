# Doubt Marketplace Backend: Claude Code Build Instructions

You are building the backend for a tutoring marketplace. Students post doubts, tutors place sealed bids, and the accepted tutor teaches a paid live video session. Students pay with UPI.

**Start with Part 0 only. Follow the working rules below.**

---

## 1. Working rules

1. Build one part at a time, in order. Never start the next part on your own.
2. Before coding each part, inspect the repo and briefly state your plan. Don't wait for approval unless you are blocked.
3. Finish a part only when its code, migrations, tests and listed checks all pass.
4. Run these before reporting a part as done:
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - `pnpm db:migrate` against a clean database, once the database exists
   - the manual check listed for that part
5. Commit the finished part as `part-NN: short description`.
6. Then stop and report:
   - what you built
   - the exact commands you ran, with their results
   - how I can test it locally
   - any decisions, risks or changes to earlier parts
7. Wait until I reply `continue`.
8. Never claim a check passed unless you ran it. If something fails and you can't fix it, stop and show me the error.
9. Never commit secrets. Add every setting to `.env.example` with a safe placeholder.
10. Use test mode only. Never process real money.
11. Check official documentation before coding any external API. If the docs differ from this file, follow the docs and tell me.
12. Don't add features, services or frontend work beyond the current part.

---

## 2. Product scope

Build these features across the parts:

- **Sealed bids:** Students see all bids. Tutors see only the bid count, never rival prices.
- **Protected UPI payments:** Money is tracked as held until the session and dispute window end.
- **Live sessions:** LiveKit provides video, audio, attendance and recording.
- **Mastery Score:** Exit quizzes and 7-day rechecks produce a tutor score.
- **Smart replay:** After consent, sessions get a recording, searchable transcript, notes and flashcards.
- **Low-bandwidth mode:** The backend records mode changes and whiteboard snapshots. Media adaptation happens on the client.
- **Doubt pooling:** Students with similar doubts can opt in to a cheaper group session.

Do not build a live AI tutor copilot.

The first market is India, and the first niche is Grade 11-12 maths.

---

## 3. Technical stack

Use current stable versions unless a part says otherwise.

| Area | Choice |
| --- | --- |
| Language | TypeScript in strict mode |
| Framework | NestJS on Express, with `rawBody: true` |
| Package manager | pnpm |
| Database | PostgreSQL with pgvector |
| Database access | Drizzle ORM and Drizzle Kit migrations |
| Cache and queue | Redis, BullMQ, `@nestjs/bullmq` |
| Realtime | Socket.IO with Redis adapter |
| Storage | S3-compatible API; MinIO locally |
| Video | LiveKit server and Egress |
| Payments | Razorpay UPI; local fake gateway |
| Validation | `class-validator` for DTOs; Zod for environment settings |
| API docs | `@nestjs/swagger` at `/docs`, disabled in production |
| Password hashing | Argon2id |
| Logging | Pino with a request ID |
| Tests | Jest and Supertest, using real PostgreSQL and Redis |
| Metrics and traces | Prometheus and OpenTelemetry |

### Folder structure

```text
src/
  app/
    api.main.ts
    worker.main.ts
  modules/
    identity/
    tutors/
    catalog/
    doubts/
    bidding/
    sessions/
    replay/
    payments/
    pooling/
    mastery/
    disputes/
    notifications/
    realtime/
  platform/
    clock/
    config/
    database/
    errors/
    outbox/
    queue/
    storage/
    telemetry/
  providers/
    upi/
    livekit/
    transcription/
    embeddings/
    replay-assets/
test/
  integration/
  concurrency/
  fixtures/
```

### Architecture rules

- Deploy a modular monolith with two entry points: API and worker.
- A module may not query another module's tables. It calls that module's exported service.
- Any state change and its outbox event must commit in the same database transaction.
- Slow work runs in the worker.
- PostgreSQL is the source of truth. Redis must contain only data that can be rebuilt.
- REST changes state. WebSockets only announce saved changes.
- All time-based logic uses an injectable `Clock`, so tests can simulate time.
- All delayed jobs need a database sweep as a safety net.

---

## 4. Shared rules

### Money

- Store amounts as `BIGINT` paise. Never use floats.
- Use Drizzle `bigint` in number mode, and reject values above `Number.MAX_SAFE_INTEGER`.
- Set currency to `INR` on payments.
- Keep ledger tables append-only. Block `UPDATE` and `DELETE` with database triggers.

### Errors

Return this JSON format:

```json
{
  "error": {
    "code": "BID_ALREADY_ACCEPTED",
    "message": "This bid can no longer be accepted.",
    "details": {},
    "requestId": "req_123"
  }
}
```

Use `409` for invalid state changes and `403` for ownership failures.

### Idempotency

Money-changing requests require an `Idempotency-Key` header. Save the request hash and response. Repeating a key with the same body returns the first response. Repeating it with a different body returns `409`.

### Default settings

Store these in `.env` or configuration:

```text
PAYMENT_WINDOW_MINUTES=15
DISPUTE_WINDOW_HOURS=24
NO_SHOW_GRACE_MINUTES=10
POOL_MAX_SEATS=5
RECHECK_DAYS=7
MASTERY_K=10
MASTERY_MIN_ATTEMPTS=10
PLATFORM_FEE_BPS=1000
EMBEDDING_DIM=1024
HOLD_MODE=ledger_only
UPI_PROVIDER=fake
```

The fee is a placeholder that I can change later.

### State transitions

Change state only through guarded updates in the owning module. If no row changes, return `409`.

```text
Doubt:
DRAFT -> OPEN
OPEN -> POOLED | RESERVED | EXPIRED | CANCELLED
POOLED -> RESERVED | OPEN | EXPIRED | CANCELLED
RESERVED -> BOOKED | OPEN
BOOKED -> COMPLETED | OPEN | CANCELLED

Bid:
SUBMITTED -> ACCEPTED | HELD | WITHDRAWN | EXPIRED
HELD -> SUBMITTED | REJECTED | EXPIRED
ACCEPTED -> EXPIRED

Session:
PENDING_PAYMENT -> SCHEDULED | CANCELLED
SCHEDULED -> LIVE | NO_SHOW | CANCELLED
LIVE -> ENDED

Participant:
PENDING_PAYMENT -> CONFIRMED | CANCELLED
CONFIRMED -> JOINED | ABSENT | CANCELLED
JOINED -> ATTENDED

Payment:
INITIATED -> VERIFIED | FAILED
VERIFIED -> HELD | REFUNDED
HELD -> RELEASED | REFUNDED | FROZEN
FROZEN -> RELEASED | REFUNDED

Pool:
FORMING -> BIDDING | EXPIRED | CANCELLED
BIDDING -> AWAITING_PAYMENTS | EXPIRED | CANCELLED
AWAITING_PAYMENTS -> CONFIRMED | EXPIRED | CANCELLED
```

### Security rules

- Check record ownership on every read and write.
- Never expose quiz answer keys, password hashes, tokens or rival bid prices.
- Keep storage buckets private. Use short-lived presigned URLs.
- Validate upload type and size.
- Rate-limit login, posting and bidding with Redis.
- Mask phone numbers and emails in doubts and bid text.
- Record admin decisions in `audit_log`.

### Minors

Treat anyone under 18 as a minor.

- A minor's account stays `PENDING_GUARDIAN` until a guardian approves it.
- Only tutors with `can_teach_minors = true` can bid on or teach minors' doubts.
- Peer tutors can't teach minors in version 1.
- Keep contact on the platform.
- Pool only within the same grade band, and hide minors' identities from other students.
- Require guardian consent before recording a minor.
- Don't use minors' data for ads, profiling or behavioural analytics.
- Put guardian verification behind a provider interface. Add a TODO stating that a legally approved verification method is required before production.

---

## 5. Build parts

## Part 0: Project foundation

**Goal:** Start the API, worker and local services with one command.

Build:
- NestJS project and folder structure.
- `compose.yaml` with PostgreSQL + pgvector, Redis, MinIO and LiveKit in dev mode.
- Separate development and test databases.
- `.env.example`, Zod config validation and the injectable `Clock`.
- Pino logging, request IDs and global error filter.
- Scripts: `dev`, `dev:worker`, `build`, `lint`, `typecheck`, `test`, `db:generate`, `db:migrate`, `db:seed`.
- `GET /health`, which checks PostgreSQL, Redis, MinIO and LiveKit.
- A README with setup steps.

Test:
- Invalid config stops startup with a clear message.
- `/health` returns `200` with all dependencies up.
- A stopped dependency returns `503` and identifies it.

Manual check: `docker compose up -d`, then `curl http://localhost:3000/health`.

## Part 1: Accounts and sessions

**Tables:** `users`, `refresh_tokens`, `audit_log`, `idempotency_keys`.

Build:
- Register, login, refresh, logout and `GET /me`.
- Roles: `STUDENT`, `TUTOR`, `GUARDIAN`, `ADMIN`.
- Fifteen-minute access tokens.
- Hashed, rotating refresh tokens. Reusing an old token revokes the token family.
- Role guard, ownership helper, login rate limit and reusable idempotency interceptor.
- Seed one admin from environment settings.

Test:
- Registration, login, refresh and logout.
- Reused refresh token revokes the family.
- Wrong role returns `403`.
- Idempotency replay and conflict.

Manual check: Register and call `/me` with `curl`.

## Part 2: Catalog and tutor verification

**Tables:** `subjects`, `concepts`, `tutor_profiles`, `tutor_subjects`.

`tutor_profiles` must include: `badge`, `verification_status`, `bio`, `can_teach_minors`, `payout_upi_id`, `razorpay_linked_account_id`.

Build:
- Seed Grade 11-12 maths subjects and concepts.
- Public catalog endpoints.
- Tutor profile and subject management.
- Tutor verification submission and admin approval or rejection.
- `VerifiedTutorGuard`.

Test:
- Unverified tutors fail the guard.
- Verified tutors pass.
- Only admins can approve.
- Admin actions enter `audit_log`.

Manual check: Create a tutor, approve them and fetch the public profile.

## Part 3: Guardians and minor policy

**Table:** `guardian_links`.

Build:
- Calculate minor status from `date_of_birth`.
- Create and approve guardian links.
- `GuardianVerificationProvider`, with a development-only fake.
- `MinorPolicyService` for later parts.
- Delete unapproved minor accounts after 7 days through a worker sweep.

Test:
- Unapproved minors are denied.
- Only the linked guardian can approve.
- Adults don't need a guardian.
- Expired pending accounts are removed.

Manual check: Register a minor and guardian, then approve the link.

## Part 4: Doubts and uploads

**Tables:** `doubts`, `doubt_attachments`.

Endpoints:
- `POST /doubts`
- `GET /doubts`
- `GET /doubts/:id`
- `POST /doubts/:id/publish`
- `POST /doubts/:id/cancel`
- `POST /uploads/presign`

Build:
- Doubt status transitions and expiry sweep.
- Browse doubts by subject, concept and status.
- Presigned uploads with file type and size checks.
- Contact-detail masking.

Test:
- Invalid transitions return `409`.
- Students can't change another student's doubt.
- Unapproved minors can't publish.
- A MinIO upload works.

Manual check: Create a doubt, upload a file and publish it.

## Part 5: Sealed bids

**Table:** `bids`.

Build:
- Create, edit and withdraw bids.
- Require a positive seat price, proposed start time and approach text or 30-second media.
- Partial unique indexes for one active bid per tutor and target.
- XOR constraint: a bid targets either `doubt_id` or `pool_id`.
- Student bid list with score explanation.
- Tutor view showing only bid count.
- Default score: `0.40M + 0.25S + 0.20R + 0.15P`, with each input from 0 to 1.
- Use neutral placeholder values until Mastery and reliability data exist.

Test:
- One active bid per tutor and doubt.
- Tutors can't read rival prices.
- Unverified or ineligible tutors can't bid.
- A student can sort by score, price and time.

Manual check: Create two bids, then compare the student and tutor views.

## Part 6: Outbox and realtime updates

**Table:** `outbox_events`.

Build:
- Transactional outbox helper and publisher with retries.
- Socket.IO authentication and Redis adapter.
- Rooms: `user:{id}`, `doubt:{id}:owner`, `doubt:{id}:tutors`, `session:{id}`.
- Events: `bid.created`, `bid.updated`, `bid.withdrawn`, `doubt.bid_count_changed`, `doubt.closed`.
- Notification records and in-app delivery. Add no email or push provider yet.

Test:
- A rollback publishes no event.
- Restarting the worker doesn't lose pending events.
- A tutor never receives another tutor's price.
- Unauthorized users can't join private rooms.

Manual check: Open two Socket.IO clients and create a bid.

## Part 7: Accepting bids

**Tables:** `sessions`, `session_participants`.

Add a partial unique index allowing one active participant per doubt.

Implement `POST /bids/:id/accept`:

1. Start a transaction.
2. Lock the doubt with `SELECT ... FOR UPDATE`.
3. Check that the doubt is `OPEN` and the bid is `SUBMITTED`.
4. Mark the bid `ACCEPTED`.
5. Mark other active bids `HELD`.
6. Mark the doubt `RESERVED`.
7. Create a `PENDING_PAYMENT` session and participant.
8. Write outbox events and commit.
9. Schedule the payment expiry job after commit.

On expiry:
- Cancel the session and participant.
- Set the accepted bid to `EXPIRED`.
- Set held bids to `SUBMITTED`.
- Reopen the doubt.

Test:
- 50 concurrent accept requests create exactly one reservation.
- Expiry reopens the doubt.
- The expiry job can run twice safely.

Manual check: Accept a bid and fast-forward the clock.

## Part 8: Double-entry ledger

**Tables:** `ledger_accounts`, `ledger_transactions`, `ledger_entries`.

Build only an internal ledger, with no gateway.

Required accounts:
- `gateway_clearing`
- `held_funds`
- `tutor_payable:{tutorId}`
- `platform_revenue`
- `payout_clearing`

Required postings:

| Event | Debit | Credit |
| --- | --- | --- |
| Payment verified | `gateway_clearing` | `held_funds` |
| Hold released | `held_funds` | `tutor_payable` + `platform_revenue` |
| Refund sent | `held_funds` | `gateway_clearing` |
| Payout recorded | `tutor_payable` | `payout_clearing` |

Build:
- Unique transaction idempotency key.
- Debits-equal-credits service check.
- Deferred database constraint trigger as a second check.
- Immutable ledger triggers.
- Account balance and reconciliation queries.

Test:
- Randomized transactions always balance.
- Unbalanced transactions fail.
- Repeated posting creates one transaction.
- `UPDATE` and `DELETE` fail.

Manual check: Run a seeded script and print balances.

## Part 9: UPI interface and simulator

**Tables:** `payments`, `payment_webhook_events`.

Create `UpiGateway`:

```ts
interface UpiGateway {
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  verifyCheckoutResponse(input: CheckoutResponse): boolean;
  verifyWebhook(rawBody: Buffer, signature: string): boolean;
  fetchPayment(providerPaymentId: string): Promise<ProviderPayment>;
  fetchOrderPayments(providerOrderId: string): Promise<ProviderPayment[]>;
  refund(input: RefundInput): Promise<RefundResult>;
}
```

Build:
- `FakeUpiGateway`.
- `POST /participants/:id/payments`, which needs an `Idempotency-Key`.
- `GET /payments/:id`.
- Development-only `POST /dev/fake-upi/orders/:id/pay`, which sends a correctly signed webhook.
- `POST /webhooks/:provider`.
- Save webhook events first, then process them in a job.
- On success: check amount and currency, confirm the payment, write the ledger, confirm the participant, schedule the session, reject held bids and mark the doubt `BOOKED`.
- If payment arrives after expiry or the amount differs: refund automatically and alert an admin.

Test:
- Repeated webhooks create one ledger transaction.
- Forged signatures are rejected.
- Out-of-order events are safe.
- Late and wrong-amount payments refund.
- The dev route is unavailable in production.

Manual check: Run the full flow from accepted bid to scheduled session using the simulator.

## Part 10: Razorpay UPI in test mode

Set `UPI_PROVIDER=razorpay` to use this adapter.

Read these official docs first:
- https://razorpay.com/docs/announcements/upi-collect-migration/standard-integration/
- https://razorpay.com/docs/webhooks/validate-test
- https://razorpay.com/docs/payments/payment-methods/upi/faqs

Build:
- `RazorpayUpiGateway` using the official SDK.
- Create orders on the backend.
- Return only `order_id`, amount, currency and public `key_id` to the client.
- Add `POST /payments/:id/confirm` to verify `razorpay_order_id`, `razorpay_payment_id` and `razorpay_signature`.
- Treat confirmation as a fast UI update. Final state comes from a verified webhook or a server-side API check.
- Validate webhooks against the raw body using `X-Razorpay-Signature`.
- Remove duplicates using `x-razorpay-event-id`.
- Return `2xx` within 5 seconds by saving first and processing in a job.
- Handle `payment.captured`, `order.paid`, `payment.failed`, `refund.processed` and `refund.failed`.
- Add a worker sweep that checks old `INITIATED` payments through the API.
- Never expose or offer UPI Collect. Standard Checkout should use Intent on mobile and QR on desktop.
- Add a small `dev/razorpay-checkout.html` page that opens Standard Checkout in test mode.
- Use a tunnel allowed by Razorpay, such as `zrok`, for local webhook delivery. Don't use `ngrok`.

Test:
- The adapter passes the same contract tests as the fake gateway.
- Recorded webhook fixtures pass signature and duplicate tests.
- Unknown events are saved and ignored safely.

Manual check, after I add test keys:
- Create an order.
- Complete a test payment.
- Confirm the webhook updates the local payment.

## Part 11: Sessions and LiveKit

**Table:** `session_events`.

Build:
- `POST /sessions/:id/join-token`, for the assigned tutor and paid participants only.
- Short-lived room tokens with fixed room and identity.
- `POST /webhooks/livekit`, with signature verification and event deduplication.
- Attendance from room and participant events.
- Session `LIVE` and `ENDED` transitions.
- `session.status_changed` and `session.participant_joined` events.

Test:
- An unpaid user gets no token.
- A student can't join another session.
- Duplicate webhooks are safe.
- Attendance is calculated correctly.

Manual check: Join a local room from two browser tabs using a small dev page.

## Part 12: Hold release, no-shows and disputes

**Tables:** `refunds`, `payouts`, `disputes`.

Create `HoldProvider`, with:
- `ledger_only` as the default mode.
- `razorpay_route` as an optional adapter.

Before coding the Route adapter, read:
- https://razorpay.com/docs/payments/route.md
- https://razorpay.com/docs/api/payments/route/modify-settlement-hold.md
- https://razorpay.com/docs/webhooks/route.md

Build:
- Release held money 24 hours after a session ends, unless a dispute is open.
- Refund fully if the tutor hasn't joined 10 minutes after start.
- Allow students to raise disputes during the window.
- Freeze money during disputes.
- Admin endpoints to release, refund and record manual UPI payouts.
- Tutor earnings endpoint.
- Reconciliation report comparing ledger and provider data.
- Hourly sweep for missed jobs.

Route adapter rules:
- Keep it off by default.
- Document the Razorpay Route approval requirement in the README.
- Never store customer money in a platform-owned wallet.

Test:
- Simulated time releases the correct amount and fee.
- Tutor no-show refunds and reopens the doubt.
- A dispute prevents release.
- An admin can release or refund.
- Jobs can run twice safely.
- Route adapter tests use mocks and don't need a Route account.

Manual check: Run a session to completion, then fast-forward 24 hours.

## Part 13: Quizzes and Mastery Score

**Tables:** `question_bank`, `quiz_attempts`, `tutor_mastery_stats`, `reviews`.

Build:
- Seed questions for the Grade 11-12 maths concepts.
- Create an exit quiz when a session ends.
- Create a recheck 7 days later.
- Store and never return answer keys to clients.
- Add reviews.
- Calculate score per tutor and subject:

```text
MasteryScore = (weightedPasses + k * platformAverage) / (weightedAttempts + k)
```

- An exit attempt has weight 1. A recheck has weight 2.
- Use `k = 10`.
- Hide the public score until 10 attempts, and show `New tutor` before then.
- Quiz results must never affect payment.
- Add scoring to bid ranking.

Test:
- Seeded data gives the expected score.
- Answer keys are absent from responses.
- Minimum-attempt hiding works.
- Quiz results don't change ledger balances.

Manual check: Submit quizzes and fetch a tutor's score.

## Part 14: Recording and consent

**Tables:** `recording_consents`, `recordings`.

Add LiveKit Egress to Docker Compose and read the current Egress docs before coding.

Build:
- `POST /sessions/:id/consent`.
- Start recording only when all participants consent.
- Require guardian consent for a minor.
- Upload recordings to MinIO.
- Update recording state from Egress events.
- Set a `delete_after` date and deletion sweep.
- Return recordings using presigned URLs for authorized users.

Test:
- Missing consent means no recording.
- Guardian rules apply.
- Unauthorized users can't get replay URLs.
- Retention deletion works.

Manual check: Record a short test session and open the file.

## Part 15: Transcripts and replay search

**Table:** `transcript_segments`.

Create `TranscriptionProvider` and `FakeTranscriptionProvider`. Don't choose a real provider without asking me.

Build:
- Queue transcription after recording completes.
- Save timestamped segments.
- Add PostgreSQL full-text search.
- `GET /sessions/:id/replay` and `GET /sessions/:id/replay/search?q=`.
- Retries that don't duplicate segments.
- `replay.ready` event.

Test:
- A sample file returns the right timestamp.
- Retries don't duplicate segments.
- Search can't leak another session.
- Provider failure leaves the recording usable.

Manual check: Search a fake transcript and jump to its timestamp.

## Part 16: Notes and flashcards

**Table:** `replay_assets`.

Create `ReplayAssetProvider` and a fake. Don't choose a real provider without asking me.

Build:
- Separate jobs for notes and flashcards.
- Store provider, model and status.
- Allow tutor-written notes as the fallback.
- Treat generated content as data, never instructions.

Test:
- The fake provider passes.
- Failure leaves replay usable.
- Retries don't duplicate content.
- Only authorized users can read assets.

Manual check: Generate notes for a seeded transcript.

## Part 17: Low-bandwidth support

Build:
- `POST /sessions/:id/mode-events`, to record `FULL_VIDEO`, `AUDIO_ONLY` and `WHITEBOARD_ONLY`.
- `POST /sessions/:id/whiteboard-snapshots`, with presigned upload.
- Attach final whiteboard snapshots to replay.
- Aggregate low-bandwidth metrics.
- Update the dev page to throttle video and report the mode change.

Test:
- Only participants can post events or snapshots.
- Snapshot limits work.
- Metrics count sessions correctly.

Manual check: Throttle the browser, switch to audio only and check the saved event.

## Part 18: Pool matching

**Tables:** `doubt_embeddings`, `doubt_pools`, `pool_invites`.

Create `EmbeddingProvider` and a deterministic fake. Don't choose a real provider without asking me.

Build:
- Queue embeddings when a doubt is published.
- Add an HNSW index with cosine distance.
- Match only open doubts with the same subject and grade band.
- Use a configurable similarity threshold.
- Create or join a pool, then invite students.
- `GET /pools/invites`, `POST /pools/invites/:id/accept`, `POST /pools/invites/:id/decline`.
- Never auto-join a student, and hide identities before joining.
- Fall back to the same `concept_id` if embeddings are unavailable.
- Add `scripts/evaluate-pool-threshold.ts`, using a small hand-labelled fixture and reporting precision and recall.

Test:
- Matches stay within subject and grade band.
- Students must opt in.
- Identities stay hidden.
- Provider failure uses the fallback.

Manual check: Publish three similar doubts and one different doubt.

## Part 19: Pool bids and group payments

Build:
- `POST /pools/:id/bids`, with seat price, minimum seats, maximum seats and proposed time.
- Enforce `POOL_MAX_SEATS`.
- Students accept the pool offer and pay separately.
- One session with multiple participants.
- Set a payment deadline.
- If minimum seats are reached: confirm the session.
- If not: refund all payments, expire the pool and reopen each doubt.
- Each participant gets separate payment, dispute, release and refund records.

Test:
- Too few payments refund everyone.
- Enough payments create one session.
- One student's dispute freezes only their money.
- 20 concurrent payments can't exceed maximum seats.

Manual check: Run a three-student pool with the simulator.

## Part 20: Hardening and results

Build:
- OpenTelemetry traces and Prometheus metrics.
- k6 tests for bid creation, bid acceptance and webhook processing.
- Metrics: bid delivery p95, acceptance conflicts prevented, reconciliation mismatches, session completion, tutor no-show rate, low-bandwidth share, pool invite acceptance, quiz pass rates.
- Docker image for API and worker.
- Final OpenAPI review.
- Security pass for authorization, rate limits and secrets.
- `docs/RESULTS.md`, using only numbers measured from real tests.
- README architecture and resume summary.

Test:
- All automated tests pass from a clean checkout.
- Load test reports are saved.
- Metrics appear at `/metrics`.

Manual check: Run the demo from registration to payment release and show the report.

---

## 6. Before real launch

These are not part of the build, and they must be checked before real money or real minors are involved:

- Razorpay approval and Route eligibility.
- RBI-compliant money flow, without a platform-held wallet.
- DPDP-compliant notice, parental consent and child-data handling.
- Tutor background checks and a child-safety reporting process.
- Terms, refund policy and privacy policy.

---

## 7. Begin

Begin Part 0 now. Do only Part 0, then stop and report as described in the working rules.
