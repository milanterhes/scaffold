import { describe, expect, it, layer } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { MemoryStorage, MemoryStorageLayer } from "./storage/memory.ts"
import { AuthStorage } from "./storage.ts"
import { HasherTest } from "./hashing.ts"
import { MemoryMailerLayer } from "./mailer.ts"

const TestLayer = Layer.mergeAll(MemoryStorageLayer, MemoryMailerLayer, HasherTest)

layer(TestLayer)("auth service seams", (it) => {
  it.effect("round-trips a user through the AuthStorage seam", () =>
    Effect.gen(function*() {
      const storage = yield* AuthStorage
      const memory = yield* MemoryStorage

      const user = yield* storage.createUser("alice@example.com", false)
      expect(user.email).toBe("alice@example.com")
      expect(user.emailVerified).toBe(false)

      const found = yield* storage.getUserByEmail("alice@example.com")
      expect(found._tag).toBe("Some")
      if (found._tag === "Some") expect(found.value.id).toBe(user.id)

      yield* storage.setEmailVerified(user.id, true)
      const verified = yield* storage.getUserById(user.id)
      if (verified._tag === "Some") expect(verified.value.emailVerified).toBe(true)

      const all = yield* memory.users
      expect(all).toHaveLength(1)
    }))
})