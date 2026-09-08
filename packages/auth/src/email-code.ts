import { Clock, Context, Crypto, Duration, Effect, Layer, Option } from "effect"
import { AuthStorage } from "./storage.ts"
import { Hasher } from "./hashing.ts"
import { Mailer } from "./mailer.ts"
import { createSession } from "./session.ts"
import type { Session, User } from "./types.ts"

export const EMAIL_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
export const EMAIL_CODE_LENGTH = 8
export const EMAIL_CODE_BYTES = 5
export const EMAIL_CODE_TTL: Duration.Duration = Duration.hours(1)

const TOKEN_BUCKET_CAPACITY = 5
const TOKEN_BUCKET_REFILL_INTERVAL: Duration.Duration = Duration.minutes(1)

export class TokenBucket extends Context.Service<TokenBucket, {
  readonly take: (key: string) => Effect.Effect<boolean>
}>()("app/auth/TokenBucket") {}

export const TokenBucketLive: Layer.Layer<TokenBucket, never, Clock.Clock> = Layer.effect(
  TokenBucket,
  Effect.gen(function*() {
    const clock = yield* Clock.Clock
    const state = new Map<string, { tokens: number; lastRefillMillis: number }>()
    const refillMillis = Duration.toMillis(TOKEN_BUCKET_REFILL_INTERVAL)
    return TokenBucket.of({
      take: (key) =>
        Effect.gen(function*() {
          const now = yield* clock.currentTimeMillis
          const bucket = state.get(key)
          if (bucket === undefined) {
            state.set(key, { tokens: TOKEN_BUCKET_CAPACITY - 1, lastRefillMillis: now })
            return true
          }
          const refills = Math.floor((now - bucket.lastRefillMillis) / refillMillis)
          if (refills > 0) {
            bucket.tokens = Math.min(TOKEN_BUCKET_CAPACITY, bucket.tokens + refills)
            bucket.lastRefillMillis += refills * refillMillis
          }
          if (bucket.tokens > 0) {
            bucket.tokens -= 1
            return true
          }
          return false
        })
    })
  })
)

export type RequestEmailCodeError = { readonly _tag: "RateLimited" }

export type VerifyEmailCodeError =
  | { readonly _tag: "InvalidCode" }
  | { readonly _tag: "ExpiredCode" }
  | { readonly _tag: "RateLimited" }

export interface SignInSession {
  readonly id: string
  readonly email: string
  readonly expiresAt: Date
}

export interface VerifyEmailCodeResult {
  readonly user: User
  readonly session: Session
  readonly token: string
}

const generateEmailCode = (crypto: Crypto.Crypto): Effect.Effect<string> =>
  Effect.gen(function*() {
    const bytes = yield* crypto.randomBytes(EMAIL_CODE_BYTES).pipe(Effect.orDie)
    let acc = 0n
    for (const byte of bytes) {
      acc = (acc << 8n) | BigInt(byte)
    }
    let code = ""
    for (let i = 0; i < EMAIL_CODE_LENGTH; i++) {
      code += EMAIL_CODE_ALPHABET[Number(acc & 0x1fn)]
      acc = acc >> 5n
    }
    return code
  })

export const requestEmailCode = (
  email: string
): Effect.Effect<SignInSession, RequestEmailCodeError, AuthStorage | Hasher | Mailer | Crypto.Crypto | Clock.Clock | TokenBucket> =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const hasher = yield* Hasher
    const mailer = yield* Mailer
    const crypto = yield* Crypto.Crypto
    const clock = yield* Clock.Clock
    const bucket = yield* TokenBucket

    const allowed = yield* bucket.take(email.toLowerCase())
    if (!allowed) return yield* Effect.fail<RequestEmailCodeError>({ _tag: "RateLimited" })

    const code = yield* generateEmailCode(crypto)
    const codeHash = yield* hasher.hashEmailCode(code)
    const now = yield* clock.currentTimeMillis
    const expiresAt = new Date(now + Duration.toMillis(EMAIL_CODE_TTL))
    const record = yield* storage.createEmailCode(email, codeHash, expiresAt)
    yield* mailer.sendEmailCode(email, code)
    return { id: record.id, email, expiresAt: record.expiresAt }
  })

export const verifyEmailCode = (
  signInSessionId: string,
  code: string
): Effect.Effect<VerifyEmailCodeResult, VerifyEmailCodeError, AuthStorage | Hasher | Clock.Clock | TokenBucket | Crypto.Crypto> =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const hasher = yield* Hasher
    const clock = yield* Clock.Clock
    const bucket = yield* TokenBucket

    const recordOption = yield* storage.getEmailCode(signInSessionId)
    if (Option.isNone(recordOption)) {
      return yield* Effect.fail<VerifyEmailCodeError>({ _tag: "InvalidCode" })
    }
    const record = recordOption.value

    const allowed = yield* bucket.take(record.email.toLowerCase())
    if (!allowed) return yield* Effect.fail<VerifyEmailCodeError>({ _tag: "RateLimited" })

    const now = yield* clock.currentTimeMillis
    if (record.expiresAt.getTime() <= now) {
      yield* storage.deleteEmailCode(record.id)
      return yield* Effect.fail<VerifyEmailCodeError>({ _tag: "ExpiredCode" })
    }

    const matches = yield* hasher.verifyEmailCode(code, record.codeHash)
    if (!matches) {
      return yield* Effect.fail<VerifyEmailCodeError>({ _tag: "InvalidCode" })
    }

    yield* storage.deleteEmailCode(record.id)

    const userOption = yield* storage.getUserByEmail(record.email)
    const user = Option.isSome(userOption)
      ? userOption.value.emailVerified
        ? userOption.value
        : yield* storage.setEmailVerified(userOption.value.id, true)
      : yield* storage.createUser(record.email, true)

    const created = yield* createSession(user.id)
    return { user, session: created.session, token: created.token }
  })

export const invalidateEmailCodes = (email: string): Effect.Effect<void, never, AuthStorage> =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    yield* storage.deleteEmailCodesByEmail(email)
  })