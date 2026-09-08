import { Context, Effect, Option } from "effect"
import type { EmailCode, OAuthAccount, Session, User, UserExport, UserId } from "./types.ts"

/**
 * The database seam. `@app/auth` defines this interface and all its
 * logic; the implementor (`@app/auth-postgres`) owns the schema,
 * models and migrations and satisfies this contract. MySQL/Mongo
 * implementations are possible but never written; a `MemoryStorage` lives in
 * this package for tests.
 */
export class AuthStorage extends Context.Service<AuthStorage, {
  /** Create a user with the given email and verification state. */
  readonly createUser: (email: string, emailVerified: boolean) => Effect.Effect<User>
  /** Look up a user by email. */
  readonly getUserByEmail: (email: string) => Effect.Effect<Option.Option<User>>
  /** Look up a user by id. */
  readonly getUserById: (userId: UserId) => Effect.Effect<Option.Option<User>>
  /** Set the email-verification flag. */
  readonly setEmailVerified: (userId: UserId, emailVerified: boolean) => Effect.Effect<User>
  /** Store a session (tokenHash is the SHA-256 of the token secret). */
  readonly createSession: (userId: UserId, tokenHash: string, expiresAt: Date) => Effect.Effect<Session>
  /** Look up a session by id. */
  readonly getSession: (id: string) => Effect.Effect<Option.Option<Session>>
  /** Invalidate a single session. */
  readonly invalidateSession: (id: string) => Effect.Effect<void>
  /** Invalidate all sessions for a user. */
  readonly invalidateAllSessions: (userId: UserId) => Effect.Effect<void>
  /** Store an email code (codeHash is the scrypt hash). */
  readonly createEmailCode: (email: string, codeHash: string, expiresAt: Date) => Effect.Effect<EmailCode>
  /** Look up an email code by id. */
  readonly getEmailCode: (id: string) => Effect.Effect<Option.Option<EmailCode>>
  /** Delete a single email code. */
  readonly deleteEmailCode: (id: string) => Effect.Effect<void>
  /** Delete all email codes for an email (email change invalidation). */
  readonly deleteEmailCodesByEmail: (email: string) => Effect.Effect<void>
  /** Link an OAuth account to a user. */
  readonly createOAuthAccount: (
    provider: string,
    providerAccountId: string,
    userId: UserId,
    email: string | null
  ) => Effect.Effect<OAuthAccount>
  /** Resolve an OAuth account by provider + provider account id. */
  readonly getUserByProviderAccount: (
    provider: string,
    providerAccountId: string
  ) => Effect.Effect<Option.Option<OAuthAccount>>
  /** Unlink a provider account (guarded at the linking layer, ticket 09). */
  readonly deleteOAuthAccount: (
    provider: string,
    providerAccountId: string
  ) => Effect.Effect<void>
  /** Delete a user and all associated auth data (cascade). */
  readonly deleteUser: (userId: UserId) => Effect.Effect<void>
  /** Everything the auth package holds about a user. */
  readonly exportUser: (userId: UserId) => Effect.Effect<Option.Option<UserExport>>
}>()("app/auth/AuthStorage") {}

export type AuthStorageService = AuthStorage["Service"]