import { Effect } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"

/**
 * Effect-program migrations for the `auth` schema, mirroring
 * `packages/core/src/db/migrations.ts`. All tables live in the `auth` schema
 * (referenced explicitly), so this migrator coexists with the application
 * migrator without sharing namespace or journal state.
 */
export const migrations: Record<string, Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>> = {
  "0001_create_users": Effect.gen(function*(): Effect.gen.Return<void, SqlError.SqlError, SqlClient.SqlClient> {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE SCHEMA IF NOT EXISTS auth`
    yield* sql`
      CREATE TABLE auth.users (
        id text PRIMARY KEY,
        email text NOT NULL UNIQUE,
        email_verified boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `
  }),
  "0002_create_sessions": Effect.gen(function*(): Effect.gen.Return<void, SqlError.SqlError, SqlClient.SqlClient> {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE auth.sessions (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
        token_hash text NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `
    yield* sql`CREATE INDEX sessions_user_id_idx ON auth.sessions (user_id)`
  }),
  "0003_create_email_codes": Effect.gen(function*(): Effect.gen.Return<void, SqlError.SqlError, SqlClient.SqlClient> {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE auth.email_codes (
        id text PRIMARY KEY,
        email text NOT NULL,
        code_hash text NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `
    yield* sql`CREATE INDEX email_codes_email_idx ON auth.email_codes (email)`
  }),
  "0004_create_oauth_accounts": Effect.gen(function*(): Effect.gen.Return<void, SqlError.SqlError, SqlClient.SqlClient> {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE auth.oauth_accounts (
        provider text NOT NULL,
        provider_account_id text NOT NULL,
        user_id text NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
        email text,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (provider, provider_account_id)
      )
    `
    yield* sql`CREATE INDEX oauth_accounts_user_id_idx ON auth.oauth_accounts (user_id)`
  }),
  "0005_create_oauth_pending": Effect.gen(function*(): Effect.gen.Return<void, SqlError.SqlError, SqlClient.SqlClient> {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE auth.oauth_pending (
        state text PRIMARY KEY,
        provider text NOT NULL,
        verifier text NOT NULL,
        nonce text,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `
    yield* sql`CREATE INDEX oauth_pending_created_at_idx ON auth.oauth_pending (created_at)`
  })
}