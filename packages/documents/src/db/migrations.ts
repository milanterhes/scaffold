import { Effect } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"

/**
 * The `documents` schema migration record, merged into the application
 * migrator by `scripts/migrate.ts`. Follows the pattern of `@app/notes`.
 */
export const documentsMigrations: Record<string, Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>> = {
  "0002_create_documents": Effect.gen(function*(): Effect.gen.Return<void, SqlError.SqlError, SqlClient.SqlClient> {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE documents (
        id uuid PRIMARY KEY,
        user_id text NOT NULL,
        filename text NOT NULL,
        content_type text NOT NULL,
        size_bytes bigint NOT NULL,
        storage_key text NOT NULL,
        state text NOT NULL DEFAULT 'pending',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `
    yield* sql`CREATE INDEX documents_user_id_idx ON documents (user_id)`
  })
}