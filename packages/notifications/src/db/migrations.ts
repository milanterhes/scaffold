import { Effect } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"

/**
 * The `notifications` schema migration record, merged into the application
 * migrator by `scripts/migrate.ts`. Follows the pattern of `@app/notes`,
 * `@app/documents`, and `@app/jobs`.
 */
export const notificationsMigrations: Record<string, Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>> = {
  "0004_create_notifications": Effect.gen(function*(): Effect.gen.Return<void, SqlError.SqlError, SqlClient.SqlClient> {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE notifications (
        id uuid PRIMARY KEY,
        user_id text NOT NULL,
        type text NOT NULL,
        title text NOT NULL,
        body text NOT NULL,
        read_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `
    yield* sql`CREATE INDEX notifications_user_id_created_at_idx ON notifications (user_id, created_at DESC)`
  })
}