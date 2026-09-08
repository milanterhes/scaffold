import { PgClient, PgMigrator } from "@effect/sql-pg"
import { beforeAll, expect, layer } from "@effect/vitest"
import { AuthStorage } from "@app/auth"
import type { UserId } from "@app/auth"
import { Effect, Layer, Option, Redacted } from "effect"
import { Migrator, SqlClient, SqlError } from "effect/unstable/sql"
import { randomUUID } from "node:crypto"
import { AuthStoragePostgres } from "./auth-storage.ts"
import { migrations } from "./migrations.ts"

const TEST_DB_NAME = "scaffold_test"
const TEST_DB_URL = `postgres://postgres:postgres@localhost:5432/${TEST_DB_NAME}`
const ADMIN_DB_URL = "postgres://postgres:postgres@localhost:5432/postgres"

/**
 * The auth migrator's journal table, distinct from the application migrator's
 * `effect_sql_migrations` so the two migrators coexist.
 */
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

/** The Postgres `AuthStorage` over the test database, keeping `SqlClient` available. */
const TestAuthLayer: Layer.Layer<AuthStorage | SqlClient.SqlClient | PgClient.PgClient, SqlError.SqlError, never> =
  Layer.provideMerge(Layer.effect(AuthStorage, AuthStoragePostgres), TestDbLayer)

beforeAll(async () => {
  await Effect.runPromise(ensureTestDb)
  await Effect.runPromise(runAuthTestMigrations)
  const reRun = await Effect.runPromise(runAuthTestMigrations)
  expect(reRun).toEqual([])
})

const uniqueEmail = (): string => `user-${randomUUID()}@example.com`

layer(TestAuthLayer)("auth-storage round-trip", (it) => {
  it.effect("migrations created the auth schema tables", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{
        readonly users: boolean
        readonly sessions: boolean
        readonly email_codes: boolean
        readonly oauth_accounts: boolean
        readonly oauth_pending: boolean
      }>`
        SELECT
          to_regclass('auth.users') IS NOT NULL AS users,
          to_regclass('auth.sessions') IS NOT NULL AS sessions,
          to_regclass('auth.email_codes') IS NOT NULL AS email_codes,
          to_regclass('auth.oauth_accounts') IS NOT NULL AS oauth_accounts,
          to_regclass('auth.oauth_pending') IS NOT NULL AS oauth_pending
      `
      expect(rows[0].users).toBe(true)
      expect(rows[0].sessions).toBe(true)
      expect(rows[0].email_codes).toBe(true)
      expect(rows[0].oauth_accounts).toBe(true)
      expect(rows[0].oauth_pending).toBe(true)
    }))

  it.effect("creates a user and looks it up by email and id", () =>
    Effect.gen(function*() {
      const storage = yield* AuthStorage
      const email = uniqueEmail()
      const user = yield* storage.createUser(email, false)
      expect(user.email).toBe(email)
      expect(user.emailVerified).toBe(false)

      const byEmail = yield* storage.getUserByEmail(email)
      expect(Option.isSome(byEmail)).toBe(true)
      expect(Option.getOrThrow(byEmail).id).toBe(user.id)
      expect(Option.getOrThrow(byEmail).email).toBe(email)

      const byId = yield* storage.getUserById(user.id)
      expect(Option.isSome(byId)).toBe(true)
      expect(Option.getOrThrow(byId).email).toBe(email)
    }))

  it.effect("looks up users case-insensitively", () =>
    Effect.gen(function*() {
      const storage = yield* AuthStorage
      const email = uniqueEmail()
      yield* storage.createUser(`MiXeD-${email}`, false)
      const byLower = yield* storage.getUserByEmail(`mixed-${email}`)
      expect(Option.isSome(byLower)).toBe(true)
      const byUpper = yield* storage.getUserByEmail(`MIXED-${email}`)
      expect(Option.isSome(byUpper)).toBe(true)
    }))

  it.effect("returns none for unknown users", () =>
    Effect.gen(function*() {
      const storage = yield* AuthStorage
      const byEmail = yield* storage.getUserByEmail(`nobody-${randomUUID()}@example.com`)
      expect(Option.isNone(byEmail)).toBe(true)
      const byId = yield* storage.getUserById(randomUUID() as UserId)
      expect(Option.isNone(byId)).toBe(true)
    }))

  it.effect("set_email_verified flips the flag", () =>
    Effect.gen(function*() {
      const storage = yield* AuthStorage
      const user = yield* storage.createUser(uniqueEmail(), false)
      const verified = yield* storage.setEmailVerified(user.id, true)
      expect(verified.emailVerified).toBe(true)
      const reloaded = yield* storage.getUserById(user.id)
      expect(Option.getOrThrow(reloaded).emailVerified).toBe(true)
    }))

  it.effect("creates, reads, and invalidates sessions", () =>
    Effect.gen(function*() {
      const storage = yield* AuthStorage
      const user = yield* storage.createUser(uniqueEmail(), true)
      const session = yield* storage.createSession(user.id, "hash-1", new Date(Date.now() + 60_000))
      expect(session.userId).toBe(user.id)
      expect(session.tokenHash).toBe("hash-1")

      const byId = yield* storage.getSession(session.id)
      expect(Option.isSome(byId)).toBe(true)
      expect(Option.getOrThrow(byId).tokenHash).toBe("hash-1")
      expect(Option.getOrThrow(byId).expiresAt.getTime()).toBe(session.expiresAt.getTime())

      const missing = yield* storage.getSession(`nope-${randomUUID()}`)
      expect(Option.isNone(missing)).toBe(true)

      yield* storage.invalidateSession(session.id)
      const gone = yield* storage.getSession(session.id)
      expect(Option.isNone(gone)).toBe(true)
    }))

  it.effect("invalidates all sessions for a user", () =>
    Effect.gen(function*() {
      const storage = yield* AuthStorage
      const user = yield* storage.createUser(uniqueEmail(), true)
      const other = yield* storage.createUser(uniqueEmail(), true)
      yield* storage.createSession(user.id, "hash-a", new Date(Date.now() + 60_000))
      yield* storage.createSession(user.id, "hash-b", new Date(Date.now() + 60_000))
      const otherSession = yield* storage.createSession(other.id, "hash-c", new Date(Date.now() + 60_000))

      yield* storage.invalidateAllSessions(user.id)
      const remaining = yield* storage.getSession(otherSession.id)
      expect(Option.isSome(remaining)).toBe(true)

      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ readonly count: number }>`
        SELECT count(*)::int AS count FROM auth.sessions WHERE user_id = ${user.id}
      `
      expect(rows[0].count).toBe(0)
    }))

  it.effect("creates, reads, and deletes email codes", () =>
    Effect.gen(function*() {
      const storage = yield* AuthStorage
      const email = uniqueEmail()
      const code = yield* storage.createEmailCode(email, "scrypt-hash", new Date(Date.now() + 60_000))
      expect(code.email).toBe(email)
      expect(code.codeHash).toBe("scrypt-hash")

      const byId = yield* storage.getEmailCode(code.id)
      expect(Option.isSome(byId)).toBe(true)
      expect(Option.getOrThrow(byId).codeHash).toBe("scrypt-hash")

      yield* storage.deleteEmailCode(code.id)
      const gone = yield* storage.getEmailCode(code.id)
      expect(Option.isNone(gone)).toBe(true)
    }))

  it.effect("deletes all email codes for an email", () =>
    Effect.gen(function*() {
      const storage = yield* AuthStorage
      const email = uniqueEmail()
      yield* storage.createEmailCode(email, "a", new Date(Date.now() + 60_000))
      yield* storage.createEmailCode(email, "b", new Date(Date.now() + 60_000))
      yield* storage.deleteEmailCodesByEmail(email)
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ readonly count: number }>`
        SELECT count(*)::int AS count FROM auth.email_codes WHERE email = ${email}
      `
      expect(rows[0].count).toBe(0)
    }))

  it.effect("links an oauth account and resolves the user by provider account", () =>
    Effect.gen(function*() {
      const storage = yield* AuthStorage
      const user = yield* storage.createUser(uniqueEmail(), true)
      const account = yield* storage.createOAuthAccount("github", "acct-123", user.id, user.email)
      expect(account.userId).toBe(user.id)
      expect(account.email).toBe(user.email)

      const found = yield* storage.getUserByProviderAccount("github", "acct-123")
      expect(Option.isSome(found)).toBe(true)
      expect(Option.getOrThrow(found).userId).toBe(user.id)
      expect(Option.getOrThrow(found).provider).toBe("github")

      const missing = yield* storage.getUserByProviderAccount("github", "nope")
      expect(Option.isNone(missing)).toBe(true)
    }))

  it.effect("exports a user with their oauth accounts", () =>
    Effect.gen(function*() {
      const storage = yield* AuthStorage
      const user = yield* storage.createUser(uniqueEmail(), false)
      yield* storage.createOAuthAccount("google", "g-1", user.id, user.email)
      yield* storage.createOAuthAccount("github", "gh-1", user.id, user.email)

      const exported = yield* storage.exportUser(user.id)
      expect(Option.isSome(exported)).toBe(true)
      expect(Option.getOrThrow(exported).user.id).toBe(user.id)
      expect(Option.getOrThrow(exported).user.email).toBe(user.email)
      expect(Option.getOrThrow(exported).oauthAccounts).toHaveLength(2)
      expect(Option.getOrThrow(exported).oauthAccounts.map((a) => a.provider).sort()).toEqual(["github", "google"])

      const unknown = yield* storage.exportUser(randomUUID() as UserId)
      expect(Option.isNone(unknown)).toBe(true)
    }))

  it.effect("delete_user cascades sessions, email codes, and oauth accounts", () =>
    Effect.gen(function*() {
      const storage = yield* AuthStorage
      const user = yield* storage.createUser(uniqueEmail(), true)
      yield* storage.createSession(user.id, "hash-1", new Date(Date.now() + 60_000))
      yield* storage.createSession(user.id, "hash-2", new Date(Date.now() + 60_000))
      yield* storage.createEmailCode(user.email, "code-1", new Date(Date.now() + 60_000))
      yield* storage.createOAuthAccount("github", "gh-cascade", user.id, user.email)

      yield* storage.deleteUser(user.id)

      expect(Option.isNone(yield* storage.getUserById(user.id))).toBe(true)
      expect(Option.isNone(yield* storage.exportUser(user.id))).toBe(true)
      expect(Option.isNone(yield* storage.getUserByProviderAccount("github", "gh-cascade"))).toBe(true)

      const sql = yield* SqlClient.SqlClient
      const sessions = yield* sql<{ readonly count: number }>`
        SELECT count(*)::int AS count FROM auth.sessions WHERE user_id = ${user.id}
      `
      expect(sessions[0].count).toBe(0)
      const accounts = yield* sql<{ readonly count: number }>`
        SELECT count(*)::int AS count FROM auth.oauth_accounts WHERE user_id = ${user.id}
      `
      expect(accounts[0].count).toBe(0)
      const codes = yield* sql<{ readonly count: number }>`
        SELECT count(*)::int AS count FROM auth.email_codes WHERE email = ${user.email}
      `
      expect(codes[0].count).toBe(0)
    }))
})