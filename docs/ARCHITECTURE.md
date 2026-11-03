# Tutora: architecture and build plan (v2)

This replaces the academic-only plan in `CLAUDE_CODE_BACKEND_BUILD.md`. That file's working rules,
money rules, error format, idempotency, state-machine and security rules still apply unless this
document says otherwise.

## 1. What changed

| Topic | v1 (original spec) | v2 (this plan) |
| --- | --- | --- |
| What can be taught | Grade 11-12 maths | **Any skill**: academics, stock market, content creation, tech, design, languages, … |
| Taxonomy | subjects → concepts, grade bands | **categories (2 levels) → skills → topics**, managed by staff; tutors can suggest new skills |
| Accounts | one role per account (STUDENT/TUTOR/GUARDIAN/ADMIN) | **MEMBER** accounts that both learn and teach; separate **STAFF** accounts (ADMIN, MODERATOR) |
| Client apps | one API | **Three apps** with separate API areas and tokens: student, tutor, admin (+ public browsing) |
| Tutor vetting | one verification per tutor | **Profile verification** (the person) + **per-skill approval** with evidence links |
| Minors | guardian approval flow | **No guardian flow.** Replaced by **trust & safety**: automated screening, user reports, and an admin moderation portal |
| "Doubt" | maths question | **Learning request**: a question or goal for any skill |
| Mastery Score | maths quizzes | **Outcome score**: quizzes where a skill has a question bank, plus structured learner check-ins for every skill |

## 2. System shape

```
                 ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  frontends      │ Student app  │  │  Tutor app   │  │ Admin portal │
                 └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
                        │ aud=student     │ aud=tutor       │ aud=admin (staff only)
  ┌─────────────────────▼─────────────────▼─────────────────▼──────────────────┐
  │ API process (NestJS)                                                        │
  │  src/apps/      /student/*      /tutor/*        /admin/*       /public/*    │  ← routes, DTOs, per-app docs
  │  src/modules/   identity · catalog · tutors · trust-safety · requests ·    │  ← data + business rules
  │                 bidding · sessions · payments · ledger · disputes · …      │
  │  src/platform/  config · db · redis · queue · storage · audit · outbox …   │  ← infrastructure
  │  src/providers/ livekit · upi · transcription · embeddings · screening …   │  ← external services behind interfaces
  └───────────┬────────────────────────────────────────────────────────────────┘
              │ outbox events / BullMQ jobs
  ┌───────────▼────────────┐   PostgreSQL (+pgvector, pg_trgm) · Redis · S3 storage · LiveKit
  │ Worker process          │
  └────────────────────────┘
```

- **Still a modular monolith** with two entry points (API, worker). The three apps are API
  *areas* in one deployable, not three services. Splitting later means putting each area behind
  its own domain/gateway; no code changes in modules.
- **Layering rule:** `apps` may call any module's exported service; `modules` never import from
  `apps`; a module never queries another module's tables.
- **Docs per app:** `/docs/student`, `/docs/tutor`, `/docs/admin`, `/docs/public` (not in production).

## 3. Identity and the three apps (built: Part 1)

- `users.account_type`: `MEMBER` or `STAFF`. `users.staff_role`: `ADMIN` | `MODERATOR` (staff only;
  enforced by a check constraint). `users.status`: `ACTIVE` | `SUSPENDED` | `BANNED`.
- One member account works in **both** the student and tutor apps (sign in to each separately).
  Staff accounts only work in the admin app; they are created by seed or by an admin, never by sign-up.
- Access tokens carry `aud` = app. Every controller declares `@ForApp('student' | 'tutor' | 'admin')`;
  the global guard rejects a token from another app with `401 TOKEN_APP_MISMATCH`.
- Refresh tokens belong to one app; rotation and reuse detection are per app (reuse in the student
  app does not sign the user out of the tutor app).
- Admin-app routes use `@StaffRoles('ADMIN')` or `@StaffRoles('ADMIN', 'MODERATOR')`.
- Suspended/banned users can't sign in, refresh or use existing access tokens.

## 4. Catalog (built: Part 2)

- `categories` (two levels: e.g. *Academics → School Mathematics*), `skills`, `topics`.
- `skills.learner_notice`: shown to learners before booking. Seeded for finance skills:
  *"Education only, not investment advice."*
- Staff manage the catalog in the admin app (create, edit, move, deactivate; never hard-delete).
- Tutors suggest missing skills (`skill_suggestions`); staff approve (creates the skill, optionally
  renamed or moved) or reject. Every staff change is in `audit_log`.
- Search: `ILIKE` on name/description backed by a `pg_trgm` index; category filter includes sub-categories.

## 5. Tutors (built: Part 2)

- `tutor_profiles` (person-level): headline, bio, languages, experience, payout UPI (private),
  badge (`NONE`/`VERIFIED`/`EXPERT`), verification status.
- `tutor_skills` (per skill): experience, summary, up to 5 https evidence links
  (portfolio, certificates such as NISM, channel, published work), status `PENDING`/`APPROVED`/`REJECTED`.
- **Can teach a skill** = profile `VERIFIED` + skill claim `APPROVED` + skill active + account active
  (`TutorsService.canTeach`). Bidding (Part 5) uses this.
- Public directory: `/public/tutors?skillId=` and `/public/tutors/:id` show approved skills only.

## 6. Trust & safety (built: Part 3): replaces guardians

Goal: any unprofessional behaviour is detected or reported, reviewed by staff, and acted on.

**Tables:** `content_flags`, `reports`, `moderation_cases`, `moderation_actions` (append-only),
`user_restrictions`.

1. **Automated screening** (`ScreeningProvider` with a rule-based default):
   - Runs on every user-written text: bios, skill summaries, requests, bids, review text, chat
     (when added), and on display names.
   - Detects: phone numbers, emails, UPI IDs, social handles, "pay me directly / outside the app",
     abusive language, sexual content, guaranteed-returns / stock-tip language in finance skills.
   - Outcome per rule: `MASK` (hide contact details, keep text), `HOLD` (save but hide until
     reviewed), or `BLOCK` (reject with `422 CONTENT_BLOCKED`). Every hit writes a `content_flag`.
2. **User reports:** any member can report a user, request, bid, session or review from the
   student or tutor app (`POST /student/reports`, `POST /tutor/reports`) with a reason category
   (harassment, off-platform payment, no-show, misleading claims, inappropriate content,
   financial advice/tips, spam, other).
3. **Moderation cases:** flags and reports about the same user group into one case with a
   priority (severity × repeat count). Admin portal queue:
   `GET /admin/moderation/cases`, `GET /admin/moderation/cases/:id` (full context: content,
   history, prior actions; session recordings once Part 14 exists), assign, add notes.
4. **Actions** (`ADMIN` or `MODERATOR`, always with a reason, always audited):
   dismiss · warn · remove content · restrict (no bidding / no posting for N days) ·
   suspend (time-limited, revokes all sessions) · ban · revoke a skill approval or the tutor badge.
   Suspensions are lifted by a worker sweep.
5. **Strikes:** each upheld case adds a strike; thresholds trigger automatic restrictions
   (configurable), e.g. 3 strikes in 90 days → 7-day suspension pending review.
6. **Appeals:** a member can appeal an action once; a different staff member decides.
7. **Admin dashboard metrics:** open cases by age/priority, flags per rule, actions per moderator,
   repeat offenders.

## 7. Revised build parts

| Part | Name | Status | Main change from v1 |
| --- | --- | --- | --- |
| 0 | Project foundation | ✅ done | — |
| 1 | Accounts and the three apps | ✅ done (reworked) | member/staff accounts, per-app tokens |
| 2 | Skill catalog and tutor verification | ✅ done (reworked) | categories/skills/topics, per-skill approval, suggestions |
| 3 | **Trust & safety** | ✅ done | replaces "Guardians and minor policy" |
| 4 | Learning requests and uploads | ✅ done | "doubts" → requests: skill, optional topic, level (beginner/intermediate/advanced), goal, budget hint; screening applied |
| 5 | Sealed bids | ✅ done | eligibility = `canTeach(tutor, request.skill)`; bid text screened |
| 6 | Outbox and realtime | ✅ done | rooms per app: `student:user:{id}`, `tutor:user:{id}`, `request:{id}:owner`, `request:{id}:tutors`, `session:{id}`, `admin:moderation` |
| 7 | Accepting bids | ✅ done | unchanged |
| 8 | Double-entry ledger | ✅ done | unchanged |
| 9 | UPI interface and simulator | ✅ done | unchanged |
| 10 | Razorpay UPI (test mode) | ✅ done | live keys are refused at startup; tests use a mocked SDK and fixture data | unchanged |
| 11 | Sessions and LiveKit | ✅ done | in-session reports go to trust & safety |
| 12 | Holds, no-shows and disputes | ✅ done | disputes can open a moderation case |
| 13 | Outcomes and tutor score | ✅ done | per-skill question banks where they exist; learner check-in (goal met? 1–5) + 7-day follow-up for every skill; score per tutor **per skill** |
| 14 | Recording and consent | ✅ done | staff may open recordings only for an open case or dispute (audited) |
| 15 | Transcripts and replay search | ✅ done | fake transcription provider only | unchanged |
| 16 | Notes and flashcards | ✅ done | fake generator only | unchanged |
| 17 | Low-bandwidth support | ✅ done | unchanged |
| 18 | Request pooling | ✅ done | fake embeddings; threshold 0.5 from `yarn pool:evaluate` | match on same **skill + level** (not grade band) |
| 19 | Pool bids and group payments | ✅ done | unchanged |
| 20 | Hardening, admin insights and results | ✅ done | see `docs/RESULTS.md`, `docs/SECURITY.md` | adds moderation and marketplace metrics to the admin portal |

## 8. Decisions taken and risks

**Decided (product owner, 2026-11-03):** no minimum-age gate and no guardian flow; recording consent is
not required to book; finance-tip language is flagged (not blocked) and reportable.

**Built in Part 3 as implemented:** rule-based screening (contacts masked; off-platform payment and
stock-tip language flagged; abuse blocked with `422`), member reports, one open case per member,
staff actions (dismiss, warn, restrict posting/bidding, suspend, ban) with append-only
`moderation_actions`, sanctions lifted by a worker sweep, strike count shown on cases.
Not built yet: automatic strike thresholds and appeals (planned for Part 20 hardening).

**Risks (still open):**

- **Minimum age.** No age gate by decision. India's DPDP Act requires verifiable parental consent
  to process data of anyone under 18, so this must be legally reviewed before launch.
- **Finance skills (SEBI).** Teaching about markets is fine; giving buy/sell recommendations for a
  fee requires SEBI registration. Mitigations planned: learner notice on finance skills,
  screening for tip/guaranteed-return language, a "financial advice/tips" report reason, and
  tutor terms. Needs legal review before launch.
- **Recording for safety.** Not required to book (decision). Moderators will have recordings only
  where everyone consented (Part 14).
- Earlier pre-launch items remain: Razorpay approval and Route, RBI-compliant money flow,
  privacy policy and terms, refund policy, tutor background checks for high-risk categories.
