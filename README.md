# Scaffold

A starter monorepo for a full-stack TypeScript app with authentication, a
Postgres-backed domain, and a TanStack Start front end — everything wired and
tested so you can copy it and start building your own feature on day one.

## What's inside

```
apps/
  web/            TanStack Start SPA + Effect HttpApi mounted at /api/*
                  (auth + notes groups), shadcn UI, typed clients
packages/
  auth/           The auth core: email-code + OAuth protocol, sessions,
                  account linking, privacy/delete. Pure Effect — no DB/email deps.
  auth-postgres/  AuthStorage + OAuthPendingStore on Postgres, own migrations
  auth-resend/    Resend mailer (falls back to a logger mailer with no key)
  core/           Shared Postgres layer (PgLive) + test-DB helpers
  notes/          A demo domain: Model, migration, repo, schema, tests
scripts/
  migrate.ts      Runs app + auth migrations against DATABASE_URL
```

## Features that work out of the box

- **Email-code sign-in** — no email provider needed to try it: without a
  `RESEND_API_KEY` the code prints to the server terminal.
- **OAuth** — Google, LinkedIn, GitHub providers, each enabled by setting its
  `*_CLIENT_ID` / `*_CLIENT_SECRET` / `*_REDIRECT_URI` in `.env`.
- **Sessions** — HttpOnly cookie with sliding expiry; `CurrentUser` is
  available to any handler behind `SessionMiddleware`.
- **Account linking** — the same verified email across email + OAuth merges
  into one user. A privacy/delete-me endpoint is included.
- **A worked example** — the `notes` group shows the full vertical slice:
  schema → Postgres repo → `HttpApi` group → impl → typed client → React page
  → tests. Copy it to add your first real feature.

## Getting started

```bash
# 1. Copy the repo and rename it
cp -R scaffold my-app && cd my-app
rg -l '@app|Scaffold|scaffold' --hidden -g '!node_modules' -g '!.git' | xargs sed -i '' 's/@app/YOUR_SCOPE/g; s/scaffold/my-app/g; s/Scaffold/My App/g'

# 2. Install, start Postgres, migrate
pnpm install
docker compose up -d
cp .env.example .env        # edit DATABASE_URL + providers as needed
pnpm migrate

# 3. Run the web app
pnpm dev                   # http://localhost:3000
```

The `pnpm test` / `pnpm lint` tasks run across all packages via Turbo.

## Adding your first feature

The `notes` package is the template. Create a sibling package (or a new group
inside `apps/web`) that:

1. Defines a `Model.Class` in `packages/<feature>/src/db/models.ts`.
2. Owns its migrations in `packages/<feature>/src/db/migrations.ts` (merged by
   `scripts/migrate.ts`).
3. Provides `Effect.fnUntraced` repo functions in
   `packages/<feature>/src/repo/*.repo.ts`.
4. Declares an `HttpApiGroup` + `HttpApi` and implements it with
   `HttpApiBuilder.group` (see `apps/web/src/api/notes.api.ts` /
   `notes.impl.ts`).
5. Adds a typed client (`apps/web/src/api/notes.ts`) and a route
   (`apps/web/src/routes/notes.tsx`).
6. Mirrors `packages/notes/src/repo/notes.repo.test.ts` and
   `apps/web/src/api/notes.api.test.ts`.

## Conventions

- Postgres is the source of truth; raw SQL via Effect's Postgres layer — no ORM.
- Migrations are Effect programs; the auth package keeps its own schema
  (`auth`) and journal so it coexists with app migrations.
- Tests use a dedicated `scaffold_test` database created on demand
  (`packages/core/src/test-utils.ts`).
- No comments unless they carry information the code does not.