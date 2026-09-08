import { expect, layer } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { MemoryStorage, MemoryStorageLayer } from "./storage/memory.ts"
import { AuthStorage } from "./storage.ts"
import { HasherTest } from "./hashing.ts"
import { MemoryMailerLayer } from "./mailer.ts"
import { deleteAuthenticatedUser, deleteUser, exportUser } from "./privacy.ts"
import type { UserId } from "./types.ts"

const TestLayer = Layer.mergeAll(MemoryStorageLayer, MemoryMailerLayer, HasherTest)

const withLayer = <R, E, R2>(testLayer: Layer.Layer<R, E, R2>) =>
  (name: string, self: () => Effect.Effect<unknown, unknown, any>) => {
    layer(testLayer)(name, (it) => {
      it.effect(name, self)
    })
  }

const itWith = withLayer(TestLayer)

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

itWith("deleteUser removes the user and all associated auth data", () =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const memory = yield* MemoryStorage
    const user = yield* storage.createUser("alice@example.com", true)
    yield* storage.createSession(user.id, "tokenHash", new Date())
    yield* storage.createOAuthAccount("google", "g1", user.id, "alice@example.com")
    yield* storage.createEmailCode("alice@example.com", "codeHash", new Date())

    yield* deleteUser(user.id)

    expect(yield* memory.users).toHaveLength(0)
    expect(yield* memory.sessions).toHaveLength(0)
    expect((yield* storage.getUserById(user.id))._tag).toBe("None")
    expect((yield* storage.getUserByEmail("alice@example.com"))._tag).toBe("None")
    expect((yield* storage.getUserByProviderAccount("google", "g1"))._tag).toBe("None")
    expect((yield* exportUser(user.id))._tag).toBe("None")
  }))

itWith("deleteUser is idempotent", () =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const user = yield* storage.createUser("bob@example.com", true)
    yield* deleteUser(user.id)
    yield* deleteUser(user.id)
    yield* deleteUser("never-created" as UserId)
    expect((yield* storage.getUserById(user.id))._tag).toBe("None")
  }))

itWith("exportUser returns a complete, structured view", () =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const user = yield* storage.createUser("carol@example.com", true)
    yield* storage.createSession(user.id, "tokenHash", new Date())
    yield* storage.createOAuthAccount("google", "g1", user.id, "carol@example.com")
    yield* storage.createOAuthAccount("github", "gh1", user.id, "carol@example.com")

    const exported = yield* exportUser(user.id)
    expect(exported._tag).toBe("Some")
    if (exported._tag === "Some") {
      expect(exported.value.user.id).toBe(user.id)
      expect(exported.value.user.email).toBe("carol@example.com")
      expect(exported.value.user.emailVerified).toBe(true)
      expect(exported.value.oauthAccounts).toHaveLength(2)
      expect(exported.value.oauthAccounts.map((a) => a.provider).sort()).toEqual(["github", "google"])
    }
  }))

itWith("exportUser returns None for an unknown user", () =>
  Effect.gen(function*() {
    expect((yield* exportUser("never-created" as UserId))._tag).toBe("None")
  }))

itWith("rejects deletion from an unauthenticated context", () =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const user = yield* storage.createUser("dave@example.com", true)
    const tag = yield* errorTag(deleteAuthenticatedUser(Option.none(), user.id))
    expect(tag).toBe("Unauthenticated")
    expect((yield* storage.getUserById(user.id))._tag).toBe("Some")
  }))

itWith("rejects deletion when the authenticated caller is not the target user", () =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const owner = yield* storage.createUser("erin@example.com", true)
    const other = yield* storage.createUser("frank@example.com", true)
    const tag = yield* errorTag(deleteAuthenticatedUser(Option.some(other.id), owner.id))
    expect(tag).toBe("Forbidden")
    expect((yield* storage.getUserById(owner.id))._tag).toBe("Some")
  }))

itWith("deleteAuthenticatedUser deletes when the caller is the target user", () =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const user = yield* storage.createUser("grace@example.com", true)
    yield* deleteAuthenticatedUser(Option.some(user.id), user.id)
    expect((yield* storage.getUserById(user.id))._tag).toBe("None")
  }))