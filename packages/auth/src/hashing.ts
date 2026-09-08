import { Context, Effect, Layer } from "effect"
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"

/**
 * The hashing seam. Session secrets (high entropy) use a fast hash; email
 * codes (40-bit entropy) use a KDF. The auth logic never hashes directly — it
 * depends on this service, so tests can install a trivial implementation and
 * live code a secure one.
 *
 * `hashSessionSecret` returns a value safe to store at rest.
 * `hashEmailCode` returns a value that also encodes the salt/params needed to
 * verify it later (verification is delegated to `verifyEmailCode`).
 */
export class Hasher extends Context.Service<Hasher, {
  readonly hashSessionSecret: (secret: string) => Effect.Effect<string>
  readonly hashEmailCode: (code: string) => Effect.Effect<string>
  readonly verifyEmailCode: (code: string, encoded: string) => Effect.Effect<boolean>
}>()("app/auth/Hasher") {}

export type HasherService = Hasher["Service"]

/**
 * Live implementation: SHA-256 for session secrets, scrypt for email codes,
 * both via `node:crypto`. Session secrets are high-entropy, so a fast hash is
 * sufficient at rest. Email codes are 40-bit, so scrypt slows brute force
 * without a fast-hash shortcut.
 */
export const HasherLive: Layer.Layer<Hasher> = Layer.succeed(
  Hasher,
  Hasher.of({
    hashSessionSecret: (secret) =>
      Effect.sync(() => createHash("sha256").update(secret, "utf8").digest("hex")),
    hashEmailCode: (code) =>
      Effect.sync(() => {
        const salt = randomBytes(16).toString("hex")
        const hash = scryptSync(code, salt, 64)
        return `scrypt$${salt}$${hash.toString("hex")}`
      }),
    verifyEmailCode: (code, encoded) =>
      Effect.sync(() => {
        const [scheme, salt, expectedHex] = encoded.split("$")
        if (scheme !== "scrypt" || salt === undefined || expectedHex === undefined) return false
        const actual = scryptSync(code, salt, 64)
        const expected = Buffer.from(expectedHex, "hex")
        return actual.length === expected.length && timingSafeEqual(actual, expected)
      })
  })
)

/**
 * Trivial test implementation: identity hashing. Fine for tests that exercise
 * the auth *logic* rather than the crypto — session secrets and codes round-trip
 * without the scrypt cost. Security-relevant tests (the ones that must prove a
 * secret is never stored in plaintext) use `HasherLive`.
 */
export const HasherTest: Layer.Layer<Hasher> = Layer.succeed(
  Hasher,
  Hasher.of({
    hashSessionSecret: (secret) => Effect.succeed(secret),
    hashEmailCode: (code) => Effect.succeed(code),
    verifyEmailCode: (code, encoded) => Effect.succeed(code === encoded)
  })
)