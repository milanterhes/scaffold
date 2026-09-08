import { Clock, Crypto, Effect, Option } from "effect"
import { timingSafeEqual } from "node:crypto"
import { SESSION_COOKIE_NAME } from "./cookie.ts"
import { AuthStorage } from "./storage.ts"
import { Hasher } from "./hashing.ts"
import type { Session, User, UserId } from "./types.ts"

const SESSION_TOKEN_DELIMITER = "."
const SESSION_SECRET_BYTES = 32
const SESSION_MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000
const SESSION_REFRESH_INTERVAL_MS = 60 * 60 * 1000

export interface CreateSessionResult {
  readonly session: Session
  readonly token: string
}

export interface ValidSession {
  readonly user: User
  readonly session: Session
  readonly token?: string
}

export type SessionError =
  | { readonly _tag: "InvalidSession" }
  | { readonly _tag: "ExpiredSession" }

export interface SessionCookieOptions {
  readonly maxAgeSeconds?: number
  readonly path?: string
  readonly domain?: string
  readonly sameSite?: "lax" | "strict" | "none"
  readonly secure?: boolean
  readonly httpOnly?: boolean
}

const safeEqual = (a: string, b: string): boolean => {
  const aBuf = Buffer.from(a, "utf8")
  const bBuf = Buffer.from(b, "utf8")
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf)
}

const parseSessionToken = (token: string): Option.Option<{ id: string; secret: string }> => {
  const index = token.indexOf(SESSION_TOKEN_DELIMITER)
  if (index === -1) return Option.none()
  const id = token.slice(0, index)
  const secret = token.slice(index + 1)
  if (id.length === 0 || secret.length === 0) return Option.none()
  return Option.some({ id, secret })
}

const generateSessionSecret = (crypto: Crypto.Crypto): Effect.Effect<string> =>
  Effect.gen(function*() {
    const bytes = yield* crypto.randomBytes(SESSION_SECRET_BYTES).pipe(Effect.orDie)
    return Buffer.from(bytes).toString("base64url")
  })

export const createSession = (
  userId: UserId
): Effect.Effect<CreateSessionResult, never, AuthStorage | Hasher | Crypto.Crypto | Clock.Clock> =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const hasher = yield* Hasher
    const crypto = yield* Crypto.Crypto
    const clock = yield* Clock.Clock
    const secret = yield* generateSessionSecret(crypto)
    const tokenHash = yield* hasher.hashSessionSecret(secret)
    const now = yield* clock.currentTimeMillis
    const expiresAt = new Date(now + SESSION_MAX_DURATION_MS)
    const session = yield* storage.createSession(userId, tokenHash, expiresAt)
    return { session, token: `${session.id}${SESSION_TOKEN_DELIMITER}${secret}` }
  })

export const validateSession = (
  token: string
): Effect.Effect<ValidSession, SessionError, AuthStorage | Hasher | Clock.Clock | Crypto.Crypto> =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const hasher = yield* Hasher
    const clock = yield* Clock.Clock
    const now = yield* clock.currentTimeMillis

    const parsed = parseSessionToken(token)
    if (Option.isNone(parsed)) {
      return yield* Effect.fail<SessionError>({ _tag: "InvalidSession" })
    }

    const storedOption = yield* storage.getSession(parsed.value.id)
    if (Option.isNone(storedOption)) {
      return yield* Effect.fail<SessionError>({ _tag: "InvalidSession" })
    }
    const stored = storedOption.value

    const presentedHash = yield* hasher.hashSessionSecret(parsed.value.secret)
    if (!safeEqual(presentedHash, stored.tokenHash)) {
      return yield* Effect.fail<SessionError>({ _tag: "InvalidSession" })
    }

    if (stored.expiresAt.getTime() <= now) {
      yield* storage.invalidateSession(stored.id)
      return yield* Effect.fail<SessionError>({ _tag: "ExpiredSession" })
    }

    let session = stored
    let refreshedToken: string | undefined = undefined
    if (now >= stored.expiresAt.getTime() - SESSION_REFRESH_INTERVAL_MS) {
      const crypto = yield* Crypto.Crypto
      const secret = yield* generateSessionSecret(crypto)
      const tokenHash = yield* hasher.hashSessionSecret(secret)
      const expiresAt = new Date(now + SESSION_MAX_DURATION_MS)
      session = yield* storage.createSession(stored.userId, tokenHash, expiresAt)
      yield* storage.invalidateSession(stored.id)
      refreshedToken = `${session.id}${SESSION_TOKEN_DELIMITER}${secret}`
    }

    const userOption = yield* storage.getUserById(session.userId)
    if (Option.isNone(userOption)) {
      yield* storage.invalidateSession(session.id)
      return yield* Effect.fail<SessionError>({ _tag: "InvalidSession" })
    }

    return refreshedToken === undefined
      ? { user: userOption.value, session }
      : { user: userOption.value, session, token: refreshedToken }
  })

export const invalidateSession = (token: string): Effect.Effect<void, never, AuthStorage> =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const parsed = parseSessionToken(token)
    if (Option.isSome(parsed)) {
      yield* storage.invalidateSession(parsed.value.id)
    }
  })

export const invalidateAllSessions = (userId: UserId): Effect.Effect<void, never, AuthStorage> =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    yield* storage.invalidateAllSessions(userId)
  })

export const rotateSession = (
  token: string
): Effect.Effect<CreateSessionResult, SessionError, AuthStorage | Hasher | Crypto.Crypto | Clock.Clock> =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const valid = yield* validateSession(token)
    const created = yield* createSession(valid.user.id)
    yield* storage.invalidateSession(valid.session.id)
    return created
  })

export const setSessionCookie = (token: string, options: SessionCookieOptions = {}): string => {
  const parts = [`${SESSION_COOKIE_NAME}=${token}`]
  const httpOnly = options.httpOnly ?? true
  const secure = options.secure ?? true
  const sameSite = options.sameSite ?? "lax"
  const path = options.path ?? "/"
  if (httpOnly) parts.push("HttpOnly")
  if (secure) parts.push("Secure")
  parts.push(`SameSite=${sameSite[0].toUpperCase()}${sameSite.slice(1)}`)
  parts.push(`Path=${path}`)
  if (options.domain !== undefined) parts.push(`Domain=${options.domain}`)
  parts.push(`Max-Age=${options.maxAgeSeconds ?? SESSION_MAX_DURATION_MS / 1000}`)
  return parts.join("; ")
}

export const clearSessionCookie = (options: SessionCookieOptions = {}): string =>
  setSessionCookie("", { ...options, maxAgeSeconds: 0 })