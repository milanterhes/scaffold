/**
 * The `auth`-schema data model. These row shapes are the storage contract the
 * Postgres `AuthStorage` implementation reads and writes; the DDL that creates
 * the tables lives in `migrations.ts`.
 *
 * Emails are stored lowercased: the implementation normalizes on both write
 * and lookup so email matching is case-insensitive, matching `MemoryStorage`.
 */

/** Table `auth.users` — one row per auth identity. */
export interface UserRow {
  readonly id: string
  readonly email: string
  readonly email_verified: boolean
}

/** Table `auth.sessions` — `token_hash` is the SHA-256 of the token secret. */
export interface SessionRow {
  readonly id: string
  readonly user_id: string
  readonly token_hash: string
  readonly expires_at: Date
}

/** Table `auth.email_codes` — `code_hash` is the scrypt hash of a sign-in code. */
export interface EmailCodeRow {
  readonly id: string
  readonly email: string
  readonly code_hash: string
  readonly expires_at: Date
}

/** Table `auth.oauth_accounts` — a user's link to an external identity provider. */
export interface OAuthAccountRow {
  readonly provider: string
  readonly provider_account_id: string
  readonly user_id: string
  readonly email: string | null
}

/** Table `auth.oauth_pending` — an in-flight OAuth authorization awaiting its callback. */
export interface OAuthPendingRow {
  readonly state: string
  readonly provider: string
  readonly verifier: string
  readonly nonce: string | null
  readonly created_at: Date
}