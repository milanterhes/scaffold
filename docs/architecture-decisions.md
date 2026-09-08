# Architecture Decisions

ADRs for the scaffold live in this single file, numbered from 01. Read the sections touching the area you're about to work in.

## ADR-0001: Decode DB rows through the model schema; never cast a driver row to satisfy a type

- **Status**: accepted
- **Date**: 2026-09-08

### Context

Postgres returns `timestamptz` columns as JS `Date` objects, but the notes model's `select` variant types `created_at`/`updated_at` as `DateTime.Utc` (via `DateTimeUtcFromString`). `sql<Note>` is a pure type assertion — it does not decode rows. The gap was bridged in `apps/web` with `note.created_at as unknown as Date`, a cast that lies to the compiler: the type claims `Utc` while the runtime value is a `Date`.

### Decision

- The model uses `Model.DateTimeInsertFromDate` / `Model.DateTimeUpdateFromDate`, whose `select` variants (`DateTimeUtcFromDate`) accept the JS `Date` the driver returns.
- Repo functions decode each driver row with `Schema.decodeUnknownSync(Note)` before returning, so the value handed back genuinely satisfies the model's types.
- Impl layers return `created_at`/`updated_at` directly. No `as` casts reconcile a type-vs-runtime mismatch anywhere in application code.

### Sanctioned exception

`apps/web/src/api/mount.ts` casts Effect's phantom requirements (`HttpRouter.Request<"Requires", SqlClient>`, `HttpServerRequest`, router context) to `never`. These are type-vs-type declarations where the runtime is provably correct (the DB, router context, and request scope are all provided by the `ManagedRuntime`); the casts assert "satisfied at runtime," which is true. This is a framework limitation (`Layer.provide` can't strip the `HttpRouter.Request` phantom), not a lie. Documented inline.

### Consequences

- Runtime values match their declared types: `DateTime.Utc` is genuinely `Utc`, not a `Date` in disguise.
- The decode boundary lives where it belongs — at the SQL-to-domain edge in the repo — so consumers downstream never cast.
- `SchemaError` enters the repo functions' error channel (`SqlError | SchemaError`); handlers use `Effect.orDie` because a failed decode is a programming error, not a client error.