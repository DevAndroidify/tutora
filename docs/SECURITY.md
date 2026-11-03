# Security review (Part 20)

Scope: the API and worker in this repository, reviewed on 2026-11-03. Items marked **Test** are
enforced by automated tests.

## Authentication and authorization

- Every route is private by default (global guard); public routes are explicitly `@Public()`.
  **Test:** every documented private route returns `401` without a token (`part20-hardening`).
- Tokens are bound to one app (`aud` = student | tutor | admin). A token from one app is rejected by
  the others. Staff accounts can only use the admin app; members never can. **Test** (`part01`).
- Admin-app actions need a staff role (`ADMIN` / `MODERATOR`). **Test.**
- Record ownership is checked on every read and write of member data (requests, bids, payments,
  sessions, recordings, quizzes, pool invites). **Test** in each part.
- Sealed bids: tutors never receive rival prices over REST or WebSockets. **Test** (`part05`, `part06`).
- Refresh tokens are random, stored only as SHA-256 hashes, rotate on use; reuse revokes the family.

## Abuse controls

- Redis rate limits: login (per app, IP and email), posting requests, bidding, reports.
- Automated screening masks contact details and flags off-platform payment and stock-tip language;
  abusive text is refused. Moderators can restrict, suspend or ban.

## Money

- Amounts are integer paise; the ledger is double-entry and append-only (database triggers), with a
  deferred trigger rejecting unbalanced commits. **Test.**
- Money-changing requests need an `Idempotency-Key`. **Test.**
- Webhooks are verified against the raw body (HMAC / LiveKit JWT), deduplicated by event id, saved
  first and processed in the worker. **Test.**
- Razorpay runs in **test mode only**: live keys (`rzp_live_`) stop startup. **Test.**
- No platform-held wallet; Route mode (off by default) keeps the tutor share in Razorpay.

## Data and files

- Buckets are private; files are reached only through short-lived presigned URLs, after a membership
  check. Uploads have type and size limits, and keys are namespaced per user and purpose. **Test.**
- Staff can view a recording only while a dispute is open, and every view is audited. **Test.**
- Generated text (notes, flashcards) is treated as data: markup and control characters are stripped.
- Logs redact `Authorization`, cookies and idempotency keys; password hashes and answer keys are never
  returned. **Test** for answer keys and password hashes.

## HTTP hardening

- `helmet` security headers (HSTS, `nosniff`, frame options, CSP in production); `x-powered-by` off.
  **Test.**
- CORS is closed unless `CORS_ORIGINS` lists frontend origins. **Test.**
- Swagger UI and `/dev/*` pages are disabled in production; `/metrics` is disabled in production unless
  `METRICS_TOKEN` is set, then requires it. **Test** (token), manual check (production 404s).
- Docker image runs as the non-root `node` user.

## Secrets

- `.env` is git-ignored; `.env.example` contains placeholders only; `.env.test` contains local test
  values (dev MinIO/LiveKit keys, a test JWT secret) and no real credentials.
- Test fixtures use made-up Razorpay ids and keys (`rzp_test_TutoraFixture01`).

## Open items before launch

- Pen test and dependency audit in CI; WAF / DDoS protection in front of the API.
- Rotate `JWT_ACCESS_SECRET` and all keys per environment; use a secrets manager.
- Legal review: DPDP (no age gate by decision), SEBI (finance skills), recording consent wording.
- Real providers for transcription, notes and embeddings need data-processing review.
