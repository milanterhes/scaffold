import { PgClient, PgMigrator } from "@effect/sql-pg"
import { beforeAll, expect, layer } from "@effect/vitest"
import { OAuthPendingStore } from "@app/auth/httpapi"
import { Effect, Layer, Redacted } from "effect"
import { Migrator, SqlClient, SqlError } from "effect/unstable/sql"
import { randomUUID } from "node:crypto"
import { migrations } from "./migrations.ts"
import { OAuthPendingStorePostgres } from "./oauth-pending-storage.ts"

const TEST_DB_NAME = "scaffold_test"
const TEST_DB_URL = `postgres://postgres:postgres@localhost:5432/${TEST_DB_NAME}`
const ADMIN_DB_URL = "postgres://postgres:postgres@localhost:5432/postgres"

const migrationsTable = "auth_migrations"

/** Create the dedicated test database if it does not exist yet. */
const ensureTestDb: Effect.Effect<void, SqlError.SqlError> = Effect.gen(function*(): Effect.gen.Return<
  void,
  SqlError.SqlError,
  SqlClient.SqlClient
> {
  const admin = yield* SqlClient.SqlClient
  const rows = yield* admin<{ readonly count: number }>`
    SELECT count(*)::int AS count FROM pg_database WHERE datname = 'scaffold_test'
  `
  if (rows[0].count === 0) {
    yield* admin`CREATE DATABASE scaffold_test`
  }
}).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(ADMIN_DB_URL) })))

/** Apply the auth-schema migrations to the test database. */
const runAuthTestMigrations: Effect.Effect<
  ReadonlyArray<readonly [number, string]>,
  Migrator.MigrationError | SqlError.SqlError
> = PgMigrator.make({})({
  loader: PgMigrator.fromRecord(migrations),
  table: migrationsTable
}).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(TEST_DB_URL) })))

const TestDbLayer: Layer.Layer<SqlClient.SqlClient | PgClient.PgClient, SqlError.SqlError, never> =
  PgClient.layer({ url: Redacted.make(TEST_DB_URL) })

/** The Postgres `OAuthPendingStore` over the test database, keeping `SqlClient` available. */
const TestPendingLayer: Layer.Layer<
  OAuthPendingStore | SqlClient.SqlClient | PgClient.PgClient,
  SqlError.SqlError,
  never
> = Layer.provideMerge(Layer.effect(OAuthPendingStore, OAuthPendingStorePostgres), TestDbLayer)

beforeAll(async () => {
  await Effect.runPromise(ensureTestDb)
  await Effect.runPromise(runAuthTestMigrations)
})

layer(TestPendingLayer)("oauth-pending round-trip", (it) => {
  it.effect("migrations created the oauth_pending table", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ readonly exists: boolean }>`
        SELECT to_regclass('auth.oauth_pending') IS NOT NULL AS exists
      `
      expect(rows[0].exists).toBe(true)
    }))

  it.effect("stores and reads a pending record", () =>
    Effect.gen(function*() {
      const store = yield* OAuthPendingStore
      const state = `state-${randomUUID()}`
      yield* store.set(state, { state, provider: "github", verifier: "verifier-1" })

      const found = yield* store.get(state)
      expect(found._tag).toBe("Some")
      if (found._tag === "Some") {
        expect(found.value).toEqual({ state, provider: "github", verifier: "verifier-1" })
      }
    }))

  it.effect("returns none for an unknown state", () =>
    Effect.gen(function*() {
      const store = yield* OAuthPendingStore
      const found = yield* store.get(`nope-${randomUUID()}`)
      expect(found._tag).toBe("None")
    }))

  it.effect("deletes a pending record", () =>
    Effect.gen(function*() {
      const store = yield* OAuthPendingStore
      const state = `state-${randomUUID()}`
      yield* store.set(state, { state, provider: "google", verifier: "verifier-2", nonce: "nonce-1" })
      yield* store.delete(state)
      const gone = yield* store.get(state)
      expect(gone._tag).toBe("None")
    }))

  it.effect("upserts on an existing state and carries the nonce", () =>
    Effect.gen(function*() {
      const store = yield* OAuthPendingStore
      const state = `state-${randomUUID()}`
      yield* store.set(state, { state, provider: "google", verifier: "v1" })
      yield* store.set(state, { state, provider: "google", verifier: "v2", nonce: "nonce-x" })

      const found = yield* store.get(state)
      expect(found._tag).toBe("Some")
      if (found._tag === "Some") {
        expect(found.value.verifier).toBe("v2")
        expect(found.value.nonce).toBe("nonce-x")
      }
    }))
})