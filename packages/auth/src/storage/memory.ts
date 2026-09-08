import { Context, Effect, Layer, Option } from "effect"
import { AuthStorage } from "../storage.ts"
import type { EmailCode, OAuthAccount, Session, User, UserExport, UserId } from "../types.ts"

const fromNullable = <A>(value: A | undefined | null): Option.Option<A> =>
  value === undefined || value === null ? Option.none() : Option.some(value)

/**
 * An in-memory `AuthStorage` over maps, used by tests. It implements every
 * method of the seam and enforces the same invariants (cascade on delete) so
 * tests exercise real behaviour, not a stub.
 */
export class MemoryStorage extends Context.Service<MemoryStorage, {
  readonly users: Effect.Effect<ReadonlyArray<User>>
  readonly sessions: Effect.Effect<ReadonlyArray<Session>>
}>()("app/auth/MemoryStorage") {}

export const MemoryStorageLayer: Layer.Layer<AuthStorage | MemoryStorage> = Layer.effectContext(
  Effect.gen(function*() {
    const users = new Map<string, User>()
    const sessions = new Map<string, Session>()
    const emailCodes = new Map<string, EmailCode>()
    const oauthAccounts = new Map<string, OAuthAccount>()

    const keyFor = (provider: string, providerAccountId: string) =>
      `${provider}::${providerAccountId}`

    const storage = AuthStorage.of({
      createUser: (email, emailVerified) =>
        Effect.sync(() => {
          const id = crypto.randomUUID() as UserId
          const user: User = { id, email, emailVerified }
          users.set(id, user)
          return user
        }),
      getUserByEmail: (email) =>
        Effect.sync(() => {
          const needle = email.toLowerCase()
          for (const user of users.values()) {
            if (user.email.toLowerCase() === needle) return Option.some(user)
          }
          return Option.none()
        }),
      getUserById: (userId) =>
        Effect.sync(() => fromNullable(users.get(userId))),
      setEmailVerified: (userId, emailVerified) =>
        Effect.sync(() => {
          const user = users.get(userId)
          if (user === undefined) throw new Error(`unknown user: ${userId}`)
          const updated = { ...user, emailVerified }
          users.set(userId, updated)
          return updated
        }),
      createSession: (userId, tokenHash, expiresAt) =>
        Effect.sync(() => {
          const session: Session = { id: crypto.randomUUID(), userId, tokenHash, expiresAt }
          sessions.set(session.id, session)
          return session
        }),
      getSession: (id) =>
        Effect.sync(() => fromNullable(sessions.get(id))),
      invalidateSession: (id) =>
        Effect.sync(() => {
          sessions.delete(id)
        }),
      invalidateAllSessions: (userId) =>
        Effect.sync(() => {
          for (const [id, session] of sessions) {
            if (session.userId === userId) sessions.delete(id)
          }
        }),
      createEmailCode: (email, codeHash, expiresAt) =>
        Effect.sync(() => {
          const code: EmailCode = { id: crypto.randomUUID(), email, codeHash, expiresAt }
          emailCodes.set(code.id, code)
          return code
        }),
      getEmailCode: (id) =>
        Effect.sync(() => fromNullable(emailCodes.get(id))),
      deleteEmailCode: (id) =>
        Effect.sync(() => {
          emailCodes.delete(id)
        }),
      deleteEmailCodesByEmail: (email) =>
        Effect.sync(() => {
          const needle = email.toLowerCase()
          for (const [id, code] of emailCodes) {
            if (code.email.toLowerCase() === needle) emailCodes.delete(id)
          }
        }),
      createOAuthAccount: (provider, providerAccountId, userId, email) =>
        Effect.sync(() => {
          const account: OAuthAccount = { provider, providerAccountId, userId, email }
          oauthAccounts.set(keyFor(provider, providerAccountId), account)
          return account
        }),
      getUserByProviderAccount: (provider, providerAccountId) =>
        Effect.sync(() => fromNullable(oauthAccounts.get(keyFor(provider, providerAccountId)))),
      deleteOAuthAccount: (provider, providerAccountId) =>
        Effect.sync(() => {
          oauthAccounts.delete(keyFor(provider, providerAccountId))
        }),
      deleteUser: (userId) =>
        Effect.sync(() => {
          const user = users.get(userId)
          users.delete(userId)
          for (const [id, session] of sessions) {
            if (session.userId === userId) sessions.delete(id)
          }
          if (user !== undefined) {
            const needle = user.email.toLowerCase()
            for (const [id, code] of emailCodes) {
              if (code.email.toLowerCase() === needle) emailCodes.delete(id)
            }
          }
          for (const [id, account] of oauthAccounts) {
            if (account.userId === userId) oauthAccounts.delete(id)
          }
        }),
      exportUser: (userId) =>
        Effect.sync(() => {
          const user = users.get(userId)
          if (user === undefined) return Option.none()
          const accounts = Array.from(oauthAccounts.values()).filter((a) => a.userId === userId)
          const export_: UserExport = { user, oauthAccounts: accounts }
          return Option.some(export_)
        })
    })

    const memory = MemoryStorage.of({
      users: Effect.sync(() => Array.from(users.values())),
      sessions: Effect.sync(() => Array.from(sessions.values()))
    })

    return Context.make(AuthStorage, storage).pipe(Context.add(MemoryStorage, memory))
  })
)