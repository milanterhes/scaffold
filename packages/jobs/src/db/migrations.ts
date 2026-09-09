import { Effect } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"

/**
 * The `jobs` schema migration record, merged into the application migrator by
 * `scripts/migrate.ts`. Follows the pattern of `@app/notes` and
 * `@app/documents`.
 */
export const jobsMigrations: Record<string, Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>> = {
  "0003_create_jobs": Effect.gen(function*(): Effect.gen.Return<void, SqlError.SqlError, SqlClient.SqlClient> {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE outbox (
        id uuid PRIMARY KEY,
        event_type text NOT NULL,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        consumed_at timestamptz NULL
      )
    `
    yield* sql`CREATE INDEX outbox_consumed_at_idx ON outbox (consumed_at)`
    yield* sql`
      CREATE TABLE jobs (
        id uuid PRIMARY KEY,
        job_type text NOT NULL,
        payload jsonb NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        attempts int NOT NULL DEFAULT 0,
        max_attempts int NOT NULL DEFAULT 3,
        run_after timestamptz NOT NULL DEFAULT now(),
        last_error text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `
    yield* sql`CREATE INDEX jobs_status_run_after_idx ON jobs (status, run_after)`
  })
}