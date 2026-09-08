import { expect, layer } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { NodeCrypto } from "@effect/platform-node"
import { MemoryStorage, MemoryStorageLayer } from "./storage/memory.ts"
import { AuthStorage } from "./storage.ts"
import { HasherTest } from "./hashing.ts"
import { MemoryMailerLayer } from "./mailer.ts"
import { TokenBucketLive } from "./email-code.ts"
import { validateSession } from "./session.ts"
import { linkWithProvider, unlinkProvider } from "./linking.ts"
import type { ProviderIdentity } from "./oauth/providers/identity.ts"

const TestLayer = Layer.mergeAll(
  MemoryStorageLayer,
  MemoryMailerLayer,
  HasherTest,
  TokenBucketLive,
  NodeCrypto.layer
)

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

const identity = (
  provider: ProviderIdentity["provider"],
  providerAccountId: string,
  email: string | null,
  emailVerified: boolean
): ProviderIdentity => ({ provider, providerAccountId, email, emailVerified, name: null, picture: null })

itWith("links a verified OAuth email to an existing user", () =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const user = yield* storage.createUser("alice@example.com", true)
    const result = yield* linkWithProvider(identity("google", "g1", "alice@example.com", true))
    expect(result.user.id).toBe(user.id)
    expect(result.isNew).toBe(false)

    const account = yield* storage.getUserByProviderAccount("google", "g1")
    expect(account._tag).toBe("Some")
    if (account._tag === "Some") {
      expect(account.value.userId).toBe(user.id)
      expect(account.value.email).toBe("alice@example.com")
    }

    const valid = yield* validateSession(result.token)
    expect(valid.user.id).toBe(user.id)
  }))

itWith("falls back to the provider identity key for an unverified email, creating a user", () =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const result = yield* linkWithProvider(identity("linkedin", "li1", "bob@example.com", false))
    expect(result.isNew).toBe(true)
    expect(result.user.email).toBe("bob@example.com")
    expect(result.user.emailVerified).toBe(false)

    const account = yield* storage.getUserByProviderAccount("linkedin", "li1")
    expect(account._tag).toBe("Some")
    if (account._tag === "Some") expect(account.value.userId).toBe(result.user.id)
    expect((yield* storage.getUserByEmail("bob@example.com"))._tag).toBe("Some")
  }))

itWith("falls back to the provider identity key when the email is absent, creating a user", () =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const result = yield* linkWithProvider(identity("linkedin", "li2", null, false))
    expect(result.isNew).toBe(true)
    expect(result.user.email).toBe("")
    expect(result.user.emailVerified).toBe(false)

    const account = yield* storage.getUserByProviderAccount("linkedin", "li2")
    expect(account._tag).toBe("Some")
    if (account._tag === "Some") expect(account.value.userId).toBe(result.user.id)
  }))

itWith("an existing provider account always wins over email matching", () =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const a = yield* storage.createUser("alice@example.com", true)
    yield* linkWithProvider(identity("google", "g1", "alice@example.com", true))

    const again = yield* linkWithProvider(identity("google", "g1", "nobody@example.com", true))
    expect(again.user.id).toBe(a.id)
    expect(again.isNew).toBe(false)
    expect((yield* storage.getUserByEmail("nobody@example.com"))._tag).toBe("None")
  }))

itWith("never merges two distinct local users silently — a conflict surfaces", () =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const memory = yield* MemoryStorage
    const a = yield* storage.createUser("alice@example.com", true)
    const b = yield* storage.createUser("bob@example.com", true)
    yield* linkWithProvider(identity("google", "g1", "alice@example.com", true))

    const tag = yield* errorTag(linkWithProvider(identity("google", "g1", "bob@example.com", true)))
    expect(tag).toBe("Conflict")

    const account = yield* storage.getUserByProviderAccount("google", "g1")
    expect(account._tag).toBe("Some")
    if (account._tag === "Some") expect(account.value.userId).toBe(a.id)
    expect((yield* storage.getUserById(b.id))._tag).toBe("Some")
    expect(yield* memory.users).toHaveLength(2)
  }))

itWith("an OAuth-verified email sets email_verified on the resolved user", () =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const first = yield* linkWithProvider(identity("linkedin", "li3", "carol@example.com", false))
    expect(first.user.emailVerified).toBe(false)

    const second = yield* linkWithProvider(identity("linkedin", "li3", "carol@example.com", true))
    expect(second.user.id).toBe(first.user.id)
    expect(second.user.emailVerified).toBe(true)
    const stored = yield* storage.getUserById(second.user.id)
    expect(stored._tag).toBe("Some")
    if (stored._tag === "Some") expect(stored.value.emailVerified).toBe(true)
  }))

itWith("an absent or unverified provider email never silently verifies the account", () =>
  Effect.gen(function*() {
    const first = yield* linkWithProvider(identity("linkedin", "li4", "erin@example.com", false))
    expect(first.user.emailVerified).toBe(false)

    const second = yield* linkWithProvider(identity("linkedin", "li4", "erin@example.com", false))
    expect(second.user.id).toBe(first.user.id)
    expect(second.user.emailVerified).toBe(false)
  }))

itWith("unlinks a provider account while keeping the user", () =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const user = yield* storage.createUser("alice@example.com", true)
    yield* linkWithProvider(identity("google", "g1", "alice@example.com", true))
    yield* unlinkProvider(user.id, "google")

    expect((yield* storage.getUserByProviderAccount("google", "g1"))._tag).toBe("None")
    expect((yield* storage.getUserById(user.id))._tag).toBe("Some")
  }))

itWith("unlinks one of several provider accounts", () =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const user = yield* storage.createUser("alice@example.com", true)
    yield* linkWithProvider(identity("google", "g1", "alice@example.com", true))
    yield* linkWithProvider(identity("github", "gh1", "alice@example.com", true))
    yield* unlinkProvider(user.id, "google")

    expect((yield* storage.getUserByProviderAccount("google", "g1"))._tag).toBe("None")
    expect((yield* storage.getUserByProviderAccount("github", "gh1"))._tag).toBe("Some")
  }))

itWith("rejects an unlink that would orphan the user", () =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    const result = yield* linkWithProvider(identity("linkedin", "li5", null, false))

    const tag = yield* errorTag(unlinkProvider(result.user.id, "linkedin"))
    expect(tag).toBe("OrphanedUser")
    expect((yield* storage.getUserByProviderAccount("linkedin", "li5"))._tag).toBe("Some")
  }))