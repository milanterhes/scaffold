/**
 * Account linking: how a fresh OAuth or email-code login resolves to a user.
 *
 * DECISION RECORD (ticket 09) — these rules are the contract:
 *
 * 1. Email-code sign-in: the first sign-in creates a user (verified email);
 *    subsequent sign-ins return the existing user. This is implemented in
 *    `email-code.ts` (`verifyEmailCode`); linking here is OAuth-only.
 *
 * 2. OAuth linking by email: when the provider returns a *verified* email that
 *    matches an existing user, the provider account is linked to that user.
 *    When the email is absent or unverified, `(provider, provider_account_id)`
 *    is the identity key: the account resolves to its owner, creating a user
 *    if none exists.
 *
 * 3. Account merging: an account whose `(provider, provider_account_id)`
 *    already exists ALWAYS resolves to its owner, even if the email differs.
 *    Two distinct local users are never merged implicitly — when a verified
 *    email would point the account at a *different* user than its owner, a
 *    `Conflict` error is surfaced to the caller instead of silently absorbing
 *    the account.
 *
 * 4. Email-verification flag: an OAuth-verified email sets `email_verified`;
 *    an email-code sign-in is always verified; a provider email that is
 *    absent/unverified never silently marks the account verified.
 *
 * 5. Unlink: a provider account can be removed from a user, guarded so a user
 *    with no remaining sign-in method (another provider account or a usable
 *    email) is never orphaned — an `OrphanedUser` error is surfaced instead.
 */
import { Clock, Crypto, Effect, Option } from "effect"
import { AuthStorage } from "./storage.ts"
import { createSession } from "./session.ts"
import { Hasher } from "./hashing.ts"
import type { ProviderIdentity } from "./oauth/providers/identity.ts"
import type { Session, User, UserId } from "./types.ts"

export type LinkingError =
  | {
      readonly _tag: "Conflict"
      readonly provider: string
      readonly providerAccountId: string
      readonly userId: UserId
      readonly email: string
    }
  | { readonly _tag: "OrphanedUser"; readonly userId: UserId; readonly provider: string }

export interface LinkWithProviderResult {
  readonly user: User
  readonly session: Session
  readonly token: string
  readonly isNew: boolean
}

/** A user has a usable email when it can receive a sign-in code (non-empty). */
const hasUsableEmail = (email: string): boolean => email.length > 0

export const linkWithProvider = (
  identity: ProviderIdentity
): Effect.Effect<LinkWithProviderResult, LinkingError, AuthStorage | Hasher | Crypto.Crypto | Clock.Clock> =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage

    const existing = yield* storage.getUserByProviderAccount(identity.provider, identity.providerAccountId)
    if (Option.isSome(existing)) {
      const ownerId = existing.value.userId
      if (identity.email !== null && identity.emailVerified) {
        const emailUser = yield* storage.getUserByEmail(identity.email)
        if (Option.isSome(emailUser) && emailUser.value.id !== ownerId) {
          return yield* Effect.fail<LinkingError>({
            _tag: "Conflict",
            provider: identity.provider,
            providerAccountId: identity.providerAccountId,
            userId: ownerId,
            email: identity.email
          })
        }
        const user = yield* storage.setEmailVerified(ownerId, true)
        return yield* finish(user, false)
      }
      const userOption = yield* storage.getUserById(ownerId)
      if (Option.isSome(userOption)) {
        return yield* finish(userOption.value, false)
      }
      return yield* createFor(identity)
    }

    if (identity.email !== null && identity.emailVerified) {
      const match = yield* storage.getUserByEmail(identity.email)
      if (Option.isSome(match)) {
        yield* storage.createOAuthAccount(
          identity.provider,
          identity.providerAccountId,
          match.value.id,
          identity.email
        )
        const user = yield* storage.setEmailVerified(match.value.id, true)
        return yield* finish(user, false)
      }
    }

    return yield* createFor(identity)

    function finish(user: User, isNew: boolean): Effect.Effect<LinkWithProviderResult, never, AuthStorage | Hasher | Crypto.Crypto | Clock.Clock> {
      return Effect.gen(function*() {
        const created = yield* createSession(user.id)
        return { user, session: created.session, token: created.token, isNew }
      })
    }

    function createFor(
      id: ProviderIdentity
    ): Effect.Effect<LinkWithProviderResult, never, AuthStorage | Hasher | Crypto.Crypto | Clock.Clock> {
      return Effect.gen(function*() {
        const storage = yield* AuthStorage
        const email = id.email ?? ""
        const emailVerified = id.email !== null && id.emailVerified
        const user = yield* storage.createUser(email, emailVerified)
        yield* storage.createOAuthAccount(id.provider, id.providerAccountId, user.id, id.email)
        return yield* finish(user, true)
      })
    }
  })

export const unlinkProvider = (
  userId: UserId,
  provider: string
): Effect.Effect<void, LinkingError, AuthStorage> =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const exportOption = yield* storage.exportUser(userId)
    if (Option.isNone(exportOption)) return
    const { user, oauthAccounts } = exportOption.value
    const account = oauthAccounts.find((a) => a.provider === provider)
    if (account === undefined) return

    const remaining = oauthAccounts.filter((a) => a.provider !== provider)
    if (remaining.length === 0 && !hasUsableEmail(user.email)) {
      return yield* Effect.fail<LinkingError>({ _tag: "OrphanedUser", userId, provider })
    }

    yield* storage.deleteOAuthAccount(account.provider, account.providerAccountId)
  })