import { Effect } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"

/**
 * The `notes` schema migration record, merged into the application migrator by
 * `scripts/migrate.ts`. Follows the pattern of `@app/auth-postgres`, where a
 * package owns its own schema and migrations.
 */
export const notesMigrations: Record<string, Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>> = {
  "0001_create_notes": Effect.gen(function*(): Effect.gen.Return<void, SqlError.SqlError, SqlClient.SqlClient> {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE notes (
        id uuid PRIMARY KEY,
        user_id text NOT NULL,
        title text NOT NULL,
        body text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `
    yield* sql`CREATE INDEX notes_user_id_idx ON notes (user_id)`
  })
}