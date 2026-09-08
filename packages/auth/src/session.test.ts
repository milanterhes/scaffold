import { expect, layer } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { NodeCrypto } from "@effect/platform-node"
import { MemoryStorage, MemoryStorageLayer } from "./storage/memory.ts"
import { AuthStorage } from "./storage.ts"
import { HasherLive, HasherTest } from "./hashing.ts"
import {
  clearSessionCookie,
  createSession,
  invalidateAllSessions,
  invalidateSession,
  rotateSession,
  setSessionCookie,
  validateSession
} from "./session.ts"

const TestLayer = Layer.mergeAll(MemoryStorageLayer, HasherTest, NodeCrypto.layer)

const SecureLayer = Layer.mergeAll(MemoryStorageLayer, HasherLive, NodeCrypto.layer)

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

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

const createUser = (email = "alice@example.com") =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    return yield* storage.createUser(email, true)
  })

itWith("a created session validates with its token", () =>
  Effect.gen(function*() {
    const user = yield* createUser()
    const created = yield* createSession(user.id)
    expect(created.token).toContain(".")
    const valid = yield* validateSession(created.token)
    expect(valid.user.id).toBe(user.id)
    expect(valid.session.id).toBe(created.session.id)
    expect(valid.token).toBeUndefined()
  }))

itWith("rejects a token with a tampered secret", () =>
  Effect.gen(function*() {
    const user = yield* createUser()
    const created = yield* createSession(user.id)
    const id = created.token.split(".")[0]
    expect(yield* errorTag(validateSession(`${id}.tampered-secret`))).toBe("InvalidSession")
  }))

itWith("rejects a token without a delimiter", () =>
  Effect.gen(function*() {
    const user = yield* createUser()
    const created = yield* createSession(user.id)
    const id = created.token.split(".")[0]
    expect(yield* errorTag(validateSession(id))).toBe("InvalidSession")
  }))

itWith("rejects a session for a deleted user", () =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const user = yield* createUser()
    const created = yield* createSession(user.id)
    yield* storage.deleteUser(user.id)
    expect(yield* errorTag(validateSession(created.token))).toBe("InvalidSession")
  }))

itWith("rejects an expired session", () =>
  Effect.gen(function*() {
    const user = yield* createUser()
    const created = yield* createSession(user.id)
    yield* TestClock.adjust(30 * DAY_MS + MINUTE_MS)
    expect(yield* errorTag(validateSession(created.token))).toBe("ExpiredSession")
  }))

itWith("slides the window on use, but not on every request", () =>
  Effect.gen(function*() {
    const memory = yield* MemoryStorage
    const user = yield* createUser()
    const created = yield* createSession(user.id)

    const first = yield* validateSession(created.token)
    expect(first.token).toBeUndefined()
    const afterFirst = yield* memory.sessions
    expect(afterFirst).toHaveLength(1)

    const second = yield* validateSession(created.token)
    expect(second.token).toBeUndefined()
    const afterSecond = yield* memory.sessions
    expect(afterSecond).toHaveLength(1)
    expect(afterSecond[0].id).toBe(created.session.id)

    yield* TestClock.adjust(29 * DAY_MS + 23 * HOUR_MS)
    const refreshed = yield* validateSession(created.token)
    expect(refreshed.token).toBeDefined()
    const afterRefresh = yield* memory.sessions
    expect(afterRefresh).toHaveLength(1)
    expect(afterRefresh[0].id).not.toBe(created.session.id)
    expect(afterRefresh[0].expiresAt.getTime()).toBeGreaterThan(created.session.expiresAt.getTime())

    const fresh = yield* validateSession(refreshed.token!)
    expect(fresh.user.id).toBe(user.id)

    expect(yield* errorTag(validateSession(created.token))).toBe("InvalidSession")
  }))

itWith("invalidateSession takes effect on the next validation", () =>
  Effect.gen(function*() {
    const user = yield* createUser()
    const created = yield* createSession(user.id)
    yield* invalidateSession(created.token)
    expect(yield* errorTag(validateSession(created.token))).toBe("InvalidSession")
  }))

itWith("invalidateAllSessions takes effect on the next validation", () =>
  Effect.gen(function*() {
    const user = yield* createUser()
    const a = yield* createSession(user.id)
    const b = yield* createSession(user.id)
    yield* invalidateAllSessions(user.id)
    expect(yield* errorTag(validateSession(a.token))).toBe("InvalidSession")
    expect(yield* errorTag(validateSession(b.token))).toBe("InvalidSession")
  }))

itWith("rotating after a privilege change invalidates the pre-rotation session", () =>
  Effect.gen(function*() {
    const user = yield* createUser()
    const created = yield* createSession(user.id)
    const rotated = yield* rotateSession(created.token)
    expect(rotated.token).not.toBe(created.token)
    const valid = yield* validateSession(rotated.token)
    expect(valid.user.id).toBe(user.id)
    expect(yield* errorTag(validateSession(created.token))).toBe("InvalidSession")
  }))

itWith("setSessionCookie builds an HttpOnly Secure SameSite cookie", () =>
  Effect.gen(function*() {
    const header = setSessionCookie("abc.def")
    expect(header).toContain("session=abc.def")
    expect(header).toContain("HttpOnly")
    expect(header).toContain("Secure")
    expect(header).toContain("SameSite=Lax")
    expect(header).toContain("Path=/")
    expect(header).toMatch(/Max-Age=\d+/)
  }))

itWith("clearSessionCookie expires the cookie", () =>
  Effect.gen(function*() {
    const header = clearSessionCookie()
    expect(header).toContain("session=")
    expect(header).toContain("Max-Age=0")
  }))

itSecure("never stores the session secret in plaintext", () =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const memory = yield* MemoryStorage
    const user = yield* storage.createUser("bob@example.com", true)
    const created = yield* createSession(user.id)
    const secret = created.token.split(".")[1]
    const sessions = yield* memory.sessions
    expect(sessions).toHaveLength(1)
    const stored = sessions[0]
    expect(stored.tokenHash).not.toBe(secret)
    expect(stored.tokenHash).not.toBe(created.token)
  }))