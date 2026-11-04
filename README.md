# Tutora

Backend for a skills marketplace: learners post what they want to learn (anything from Class 12 maths
to video editing), verified tutors place sealed bids, and the accepted tutor teaches a paid live
session. First market: India.

Student, tutor and admin apps each have their own API. Built with NestJS, TypeScript, PostgreSQL,
Redis, LiveKit and UPI payments (test mode). The web apps are in
[tutora-web](https://github.com/DevAndroidify/tutora-web).

## Run it

Needs Node 24, Yarn 4 (`corepack enable`) and Docker.

```bash
yarn install
cp .env.example .env
docker compose up -d --wait
yarn db:migrate && yarn db:seed
yarn dev:all       # API on http://localhost:3000 and the worker
```

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
