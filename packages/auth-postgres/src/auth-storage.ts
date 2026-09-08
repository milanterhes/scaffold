import { AuthStorage } from "@app/auth"
import type { EmailCode, OAuthAccount, Session, User, UserExport, UserId } from "@app/auth"
import { Effect, Layer, Option } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { randomUUID } from "node:crypto"
import type { EmailCodeRow, OAuthAccountRow, SessionRow, UserRow } from "./models.ts"

const toUser = (row: UserRow): User => ({
  id: row.id as UserId,
  email: row.email,
  emailVerified: row.email_verified
})

const toSession = (row: SessionRow): Session => ({
  id: row.id,
  userId: row.user_id as UserId,
  tokenHash: row.token_hash,
  expiresAt: row.expires_at
})

const toEmailCode = (row: EmailCodeRow): EmailCode => ({
  id: row.id,
  email: row.email,
  codeHash: row.code_hash,
  expiresAt: row.expires_at
})

const toOAuthAccount = (row: OAuthAccountRow): OAuthAccount => ({
  provider: row.provider,
  providerAccountId: row.provider_account_id,
  userId: row.user_id as UserId,
  email: row.email
})

/** Emails are stored lowercased so lookups are case-insensitive, matching `MemoryStorage`. */
const normalizeEmail = (email: string): string => email.toLowerCase()

/**
 * The Postgres implementation of `AuthStorage` over a bound `SqlClient`.
 * Storage-layer database failures are treated as defects (`Effect.orDie`),
 * matching the seam contract (`Effect.Effect<A>` carries no error channel).
 */
export const AuthStoragePostgres: Effect.Effect<AuthStorage["Service"], never, SqlClient.SqlClient> = Effect.gen(
  function*() {
    const sql = yield* SqlClient.SqlClient
    return AuthStorage.of({
      createUser: (email, emailVerified) =>
        Effect.gen(function*(): Effect.gen.Return<User, SqlError.SqlError, never> {
          const rows = yield* sql<UserRow>`
            INSERT INTO auth.users (id, email, email_verified)
            VALUES (${randomUUID()}, ${normalizeEmail(email)}, ${emailVerified})
            RETURNING id, email, email_verified
          `
          return toUser(rows[0])
        }).pipe(Effect.orDie),
      getUserByEmail: (email) =>
        Effect.gen(function*(): Effect.gen.Return<Option.Option<User>, SqlError.SqlError, never> {
          const rows = yield* sql<UserRow>`
            SELECT id, email, email_verified FROM auth.users
            WHERE email = ${normalizeEmail(email)} LIMIT 1
          `
          return rows.length === 0 ? Option.none() : Option.some(toUser(rows[0]))
        }).pipe(Effect.orDie),
      getUserById: (userId) =>
        Effect.gen(function*(): Effect.gen.Return<Option.Option<User>, SqlError.SqlError, never> {
          const rows = yield* sql<UserRow>`
            SELECT id, email, email_verified FROM auth.users
            WHERE id = ${userId} LIMIT 1
          `
          return rows.length === 0 ? Option.none() : Option.some(toUser(rows[0]))
        }).pipe(Effect.orDie),
      setEmailVerified: (userId, emailVerified) =>
        Effect.gen(function*(): Effect.gen.Return<User, SqlError.SqlError, never> {
          const rows = yield* sql<UserRow>`
            UPDATE auth.users SET email_verified = ${emailVerified}
            WHERE id = ${userId}
            RETURNING id, email, email_verified
          `
          if (rows.length === 0) throw new Error(`unknown user: ${userId}`)
          return toUser(rows[0])
        }).pipe(Effect.orDie),
      createSession: (userId, tokenHash, expiresAt) =>
        Effect.gen(function*(): Effect.gen.Return<Session, SqlError.SqlError, never> {
          const rows = yield* sql<SessionRow>`
            INSERT INTO auth.sessions (id, user_id, token_hash, expires_at)
            VALUES (${randomUUID()}, ${userId}, ${tokenHash}, ${expiresAt})
            RETURNING id, user_id, token_hash, expires_at
          `
          return toSession(rows[0])
        }).pipe(Effect.orDie),
      getSession: (id) =>
        Effect.gen(function*(): Effect.gen.Return<Option.Option<Session>, SqlError.SqlError, never> {
          const rows = yield* sql<SessionRow>`
            SELECT id, user_id, token_hash, expires_at FROM auth.sessions
            WHERE id = ${id} LIMIT 1
          `
          return rows.length === 0 ? Option.none() : Option.some(toSession(rows[0]))
        }).pipe(Effect.orDie),
      invalidateSession: (id) =>
        Effect.gen(function*(): Effect.gen.Return<void, SqlError.SqlError, never> {
          yield* sql`DELETE FROM auth.sessions WHERE id = ${id}`
        }).pipe(Effect.orDie),
      invalidateAllSessions: (userId) =>
        Effect.gen(function*(): Effect.gen.Return<void, SqlError.SqlError, never> {
          yield* sql`DELETE FROM auth.sessions WHERE user_id = ${userId}`
        }).pipe(Effect.orDie),
      createEmailCode: (email, codeHash, expiresAt) =>
        Effect.gen(function*(): Effect.gen.Return<EmailCode, SqlError.SqlError, never> {
          const rows = yield* sql<EmailCodeRow>`
            INSERT INTO auth.email_codes (id, email, code_hash, expires_at)
            VALUES (${randomUUID()}, ${normalizeEmail(email)}, ${codeHash}, ${expiresAt})
            RETURNING id, email, code_hash, expires_at
          `
          return toEmailCode(rows[0])
        }).pipe(Effect.orDie),
      getEmailCode: (id) =>
        Effect.gen(function*(): Effect.gen.Return<Option.Option<EmailCode>, SqlError.SqlError, never> {
          const rows = yield* sql<EmailCodeRow>`
            SELECT id, email, code_hash, expires_at FROM auth.email_codes
            WHERE id = ${id} LIMIT 1
          `
          return rows.length === 0 ? Option.none() : Option.some(toEmailCode(rows[0]))
        }).pipe(Effect.orDie),
      deleteEmailCode: (id) =>
        Effect.gen(function*(): Effect.gen.Return<void, SqlError.SqlError, never> {
          yield* sql`DELETE FROM auth.email_codes WHERE id = ${id}`
        }).pipe(Effect.orDie),
      deleteEmailCodesByEmail: (email) =>
        Effect.gen(function*(): Effect.gen.Return<void, SqlError.SqlError, never> {
          yield* sql`DELETE FROM auth.email_codes WHERE email = ${normalizeEmail(email)}`
        }).pipe(Effect.orDie),
      createOAuthAccount: (provider, providerAccountId, userId, email) =>
        Effect.gen(function*(): Effect.gen.Return<OAuthAccount, SqlError.SqlError, never> {
          const rows = yield* sql<OAuthAccountRow>`
            INSERT INTO auth.oauth_accounts (provider, provider_account_id, user_id, email)
            VALUES (${provider}, ${providerAccountId}, ${userId}, ${email})
            ON CONFLICT (provider, provider_account_id)
            DO UPDATE SET user_id = EXCLUDED.user_id, email = EXCLUDED.email
            RETURNING provider, provider_account_id, user_id, email
          `
          return toOAuthAccount(rows[0])
        }).pipe(Effect.orDie),
      getUserByProviderAccount: (provider, providerAccountId) =>
        Effect.gen(function*(): Effect.gen.Return<Option.Option<OAuthAccount>, SqlError.SqlError, never> {
          const rows = yield* sql<OAuthAccountRow>`
            SELECT provider, provider_account_id, user_id, email
            FROM auth.oauth_accounts
            WHERE provider = ${provider} AND provider_account_id = ${providerAccountId}
            LIMIT 1
          `
          return rows.length === 0 ? Option.none() : Option.some(toOAuthAccount(rows[0]))
        }).pipe(Effect.orDie),
      deleteOAuthAccount: (provider, providerAccountId) =>
        Effect.gen(function*(): Effect.gen.Return<void, SqlError.SqlError, never> {
          yield* sql`DELETE FROM auth.oauth_accounts
            WHERE provider = ${provider} AND provider_account_id = ${providerAccountId}`
        }).pipe(Effect.orDie),
      deleteUser: (userId) =>
        sql.withTransaction(Effect.gen(function*() {
          const rows = yield* sql<{ readonly email: string }>`
            SELECT email FROM auth.users WHERE id = ${userId}
          `
          if (rows.length === 0) return
          yield* sql`DELETE FROM auth.email_codes WHERE email = ${rows[0].email}`
          yield* sql`DELETE FROM auth.users WHERE id = ${userId}`
        })).pipe(Effect.orDie),
      exportUser: (userId) =>
        Effect.gen(function*(): Effect.gen.Return<Option.Option<UserExport>, SqlError.SqlError, never> {
          const users = yield* sql<UserRow>`
            SELECT id, email, email_verified FROM auth.users WHERE id = ${userId} LIMIT 1
          `
          if (users.length === 0) return Option.none()
          const accounts = yield* sql<OAuthAccountRow>`
            SELECT provider, provider_account_id, user_id, email
            FROM auth.oauth_accounts WHERE user_id = ${userId}
            ORDER BY provider, provider_account_id
          `
          return Option.some({ user: toUser(users[0]), oauthAccounts: accounts.map(toOAuthAccount) })
        }).pipe(Effect.orDie)
    })
  }
)

/** Layer form of `AuthStoragePostgres`, ready to be provided a `SqlClient`. */
export const AuthStoragePostgresLayer: Layer.Layer<AuthStorage, never, SqlClient.SqlClient> =
  Layer.effect(AuthStorage, AuthStoragePostgres)