import { expect, layer } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { NodeCrypto } from "@effect/platform-node"
import { MemoryStorage, MemoryStorageLayer } from "./storage/memory.ts"
import { AuthStorage } from "./storage.ts"
import { HasherLive, HasherTest } from "./hashing.ts"
import { MemoryMailer, MemoryMailerLayer } from "./mailer.ts"
import { validateSession } from "./session.ts"
import {
  EMAIL_CODE_ALPHABET,
  EMAIL_CODE_LENGTH,
  TokenBucketLive,
  invalidateEmailCodes,
  requestEmailCode,
  verifyEmailCode
} from "./email-code.ts"

const TestLayer = Layer.mergeAll(
  MemoryStorageLayer,
  MemoryMailerLayer,
  HasherTest,
  TokenBucketLive,
  NodeCrypto.layer
)

const SecureLayer = Layer.mergeAll(
  MemoryStorageLayer,
  MemoryMailerLayer,
  HasherLive,
  TokenBucketLive,
  NodeCrypto.layer
)

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * 60 * 1000

const withLayer = <R, E, R2>(testLayer: Layer.Layer<R, E, R2>) =>
  (name: string, self: () => Effect.Effect<unknown, unknown, any>) => {
    layer(testLayer)(name, (it) => {
      it.effect(name, self)
    })
  }

const itWith = withLayer(TestLayer)
const itSecure = withLayer(SecureLayer)

const errorTag = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<string | undefined, never, R> =>
  effect.pipe(
    Effect.exit,
    Effect.map((exit) => {
      if (Exit.isSuccess(exit)) return undefined
      const failure = Cause.findErrorOption(exit.cause)
      return Option.isSome(failure) ? failure.value._tag : undefined
    })
  )

const WRONG_CODE = "11111111"

itWith("a requested code lands in the mailer and verification signs the user in", () =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const memory = yield* MemoryStorage
    const mailer = yield* MemoryMailer
    const email = "alice@example.com"

    const signIn = yield* requestEmailCode(email)
    expect(signIn.email).toBe(email)

    const sent = yield* mailer.sent
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe(email)
    const code = sent[0].code
    expect(code).toHaveLength(EMAIL_CODE_LENGTH)
    expect(code.split("").every((c) => EMAIL_CODE_ALPHABET.includes(c))).toBe(true)

    const result = yield* verifyEmailCode(signIn.id, code)
    expect(result.user.email).toBe(email)
    expect(result.user.emailVerified).toBe(true)

    const users = yield* memory.users
    expect(users).toHaveLength(1)
    const sessions = yield* memory.sessions
    expect(sessions).toHaveLength(1)

    const valid = yield* validateSession(result.token)
    expect(valid.user.id).toBe(result.user.id)
    expect(storage).toBeDefined()
  }))

itSecure("stores the code scrypt-hashed, never plaintext", () =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const mailer = yield* MemoryMailer
    const signIn = yield* requestEmailCode("carol@example.com")
    const sent = yield* mailer.sent
    const code = sent[0].code
    const record = yield* storage.getEmailCode(signIn.id)
    expect(record._tag).toBe("Some")
    if (record._tag === "Some") {
      expect(record.value.codeHash).not.toBe(code)
      expect(record.value.codeHash).not.toContain(code)
      expect(record.value.codeHash.startsWith("scrypt$")).toBe(true)
    }
  }))

itWith("rejects a wrong code", () =>
  Effect.gen(function*() {
    const mailer = yield* MemoryMailer
    const signIn = yield* requestEmailCode("dave@example.com")
    const sent = yield* mailer.sent
    expect(yield* errorTag(verifyEmailCode(signIn.id, WRONG_CODE))).toBe("InvalidCode")
    expect(sent).toHaveLength(1)
  }))

itWith("rejects a code after its 1-hour TTL", () =>
  Effect.gen(function*() {
    const mailer = yield* MemoryMailer
    const signIn = yield* requestEmailCode("erin@example.com")
    const sent = yield* mailer.sent
    yield* TestClock.adjust(HOUR_MS)
    expect(yield* errorTag(verifyEmailCode(signIn.id, sent[0].code))).toBe("ExpiredCode")
  }))

itWith("a code is single-use", () =>
  Effect.gen(function*() {
    const mailer = yield* MemoryMailer
    const signIn = yield* requestEmailCode("frank@example.com")
    const sent = yield* mailer.sent
    expect(yield* errorTag(verifyEmailCode(signIn.id, sent[0].code))).toBeUndefined()
    expect(yield* errorTag(verifyEmailCode(signIn.id, sent[0].code))).toBe("InvalidCode")
  }))

itWith("the token bucket rejects codes requested faster than the refill rate", () =>
  Effect.gen(function*() {
    const mailer = yield* MemoryMailer
    const email = "grace@example.com"
    for (let i = 0; i < 5; i++) {
      expect(yield* errorTag(requestEmailCode(email))).toBeUndefined()
    }
    const sent = yield* mailer.sent
    expect(sent).toHaveLength(5)
    expect(yield* errorTag(requestEmailCode(email))).toBe("RateLimited")
    expect((yield* mailer.sent)).toHaveLength(5)
    yield* TestClock.adjust(MINUTE_MS)
    expect(yield* errorTag(requestEmailCode(email))).toBeUndefined()
  }))

itWith("the token bucket limits verification attempts per email", () =>
  Effect.gen(function*() {
    const mailer = yield* MemoryMailer
    const signIn = yield* requestEmailCode("jack@example.com")
    const sent = yield* mailer.sent
    expect(sent).toHaveLength(1)
    for (let i = 0; i < 4; i++) {
      expect(yield* errorTag(verifyEmailCode(signIn.id, WRONG_CODE))).toBe("InvalidCode")
    }
    expect(yield* errorTag(verifyEmailCode(signIn.id, WRONG_CODE))).toBe("RateLimited")
    yield* TestClock.adjust(MINUTE_MS)
    expect(yield* errorTag(verifyEmailCode(signIn.id, WRONG_CODE))).toBe("InvalidCode")
  }))

itWith("returns the existing user on a later sign-in", () =>
  Effect.gen(function*() {
    const mailer = yield* MemoryMailer
    const email = "henry@example.com"
    const first = yield* requestEmailCode(email)
    const sent1 = yield* mailer.sent
    const firstCode = sent1[0].code
    yield* mailer.clear
    const r1 = yield* verifyEmailCode(first.id, firstCode)
    const second = yield* requestEmailCode(email)
    const sent2 = yield* mailer.sent
    const r2 = yield* verifyEmailCode(second.id, sent2[0].code)
    expect(r2.user.id).toBe(r1.user.id)
    expect(r2.user.emailVerified).toBe(true)
  }))

itWith("an email change invalidates outstanding codes", () =>
  Effect.gen(function*() {
    const mailer = yield* MemoryMailer
    const signIn = yield* requestEmailCode("ida@example.com")
    const sent = yield* mailer.sent
    yield* invalidateEmailCodes("ida@example.com")
    expect(yield* errorTag(verifyEmailCode(signIn.id, sent[0].code))).toBe("InvalidCode")
  }))