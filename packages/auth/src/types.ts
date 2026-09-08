/**
 * Domain types for the auth package. These are the contract between the auth
 * logic and the `AuthStorage` implementor: they are storage-agnostic and carry
 * no SQL or migration knowledge.
 */

export type UserId = string & { readonly UserId: unique symbol }

export interface User {
  readonly id: UserId
  readonly email: string
  readonly emailVerified: boolean
}

/** A server-side auth session. `tokenHash` is the SHA-256 of the token secret. */
export interface Session {
  readonly id: string
  readonly userId: UserId
  readonly tokenHash: string
  readonly expiresAt: Date
}

/** A passwordless sign-in code, bound to an email. `codeHash` is the scrypt hash. */
export interface EmailCode {
  readonly id: string
  readonly email: string
  readonly codeHash: string
  readonly expiresAt: Date
}

/** A link between a user and an external identity provider account. */
export interface OAuthAccount {
  readonly provider: string
  readonly providerAccountId: string
  readonly userId: UserId
  readonly email: string | null
}

/** Everything the auth package holds about a user (for export / deletion). */
export interface UserExport {
  readonly user: User
  readonly oauthAccounts: ReadonlyArray<OAuthAccount>
}