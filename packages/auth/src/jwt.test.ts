import { afterAll, beforeAll, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Option } from "effect"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { createServer } from "node:http"
import { IdTokenVerifier, IdTokenVerifierLive } from "./jwt.ts"
import type { IdTokenVerificationError, VerifyIdTokenOptions } from "./jwt.ts"

const ISSUER = "https://issuer.example.com"
const AUDIENCE = "client-id"
const KID = "test-key-1"

let server: ReturnType<typeof createServer>
let jwksUri = ""
let privateKey: CryptoKey
let wrongPrivateKey: CryptoKey

beforeAll(async () => {
  const { publicKey, privateKey: pk } = await generateKeyPair("RS256")
  privateKey = pk
  const { privateKey: other } = await generateKeyPair("RS256")
  wrongPrivateKey = other
  const publicJwk = { ...(await exportJWK(publicKey)), alg: "RS256", use: "sig", kid: KID }
  server = createServer((req, res) => {
    if (req.url === "/jwks.json") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ keys: [publicJwk] }))
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("test server address unavailable")
  jwksUri = `http://127.0.0.1:${address.port}/jwks.json`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
})

const options = (overrides: Partial<VerifyIdTokenOptions> = {}): VerifyIdTokenOptions => ({
  jwksUri,
  issuer: ISSUER,
  audience: AUDIENCE,
  algorithms: ["RS256"],
  ...overrides
})

const sign = async (
  claims: Record<string, unknown> = {},
  overrides: {
    readonly alg?: string
    readonly key?: CryptoKey | Uint8Array
    readonly kid?: string
    readonly issuer?: string
    readonly audience?: string
    readonly expiration?: number | string
  } = {}
): Promise<string> => {
  const {
    alg = "RS256",
    key = privateKey,
    kid = KID,
    issuer = ISSUER,
    audience = AUDIENCE,
    expiration = "2h"
  } = overrides
  return new SignJWT(claims)
    .setProtectedHeader({ alg, ...(kid ? { kid } : {}) })
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime(expiration)
    .sign(key)
}

const b64url = (input: string): string => Buffer.from(input, "utf8").toString("base64url")

const noneToken = (): string =>
  `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(
    JSON.stringify({ iss: ISSUER, aud: AUDIENCE, sub: "user-1", exp: Math.floor(Date.now() / 1000) + 3600 })
  )}.`

const runVerify = (idToken: string, overrides: Partial<VerifyIdTokenOptions> = {}) =>
  Effect.gen(function*() {
    const verifier = yield* IdTokenVerifier
    return yield* verifier.verifyIdToken(options(overrides), idToken)
  }).pipe(Effect.provide(IdTokenVerifierLive))

const errorTag = <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E, never>
): Effect.Effect<string | undefined, never> =>
  effect.pipe(
    Effect.exit,
    Effect.map((exit) => {
      if (Exit.isSuccess(exit)) return undefined
      const failure = Cause.findErrorOption(exit.cause)
      return Option.isSome(failure) ? (failure.value as IdTokenVerificationError)._tag : undefined
    })
  )

it.effect("verifies a valid id_token signed by the provider keypair", () =>
  Effect.gen(function*() {
    const claims = {
      sub: "user-1",
      email: "alice@example.com",
      email_verified: true,
      name: "Alice",
      nonce: "nonce-1"
    }
    const token = yield* Effect.promise(() => sign(claims))
    const result = yield* runVerify(token, { nonce: "nonce-1" })
    expect(result.sub).toBe("user-1")
    expect(result.email).toBe("alice@example.com")
    expect(result.email_verified).toBe(true)
    expect(result.iss).toBe(ISSUER)
    expect(result.aud).toBe(AUDIENCE)
    expect(result.nonce).toBe("nonce-1")
  }))

it.effect("rejects an alg:none token", () =>
  Effect.gen(function*() {
    expect(yield* errorTag(runVerify(noneToken()))).toBe("AlgorithmNotAllowed")
  }))

it.effect("rejects a token signed with the wrong key", () =>
  Effect.gen(function*() {
    const token = yield* Effect.promise(() => sign({ sub: "user-1" }, { key: wrongPrivateKey }))
    expect(yield* errorTag(runVerify(token))).toBe("InvalidSignature")
  }))

it.effect("rejects a token with the wrong issuer", () =>
  Effect.gen(function*() {
    const token = yield* Effect.promise(() => sign({ sub: "user-1" }, { issuer: "https://other.example.com" }))
    expect(yield* errorTag(runVerify(token))).toBe("InvalidIssuer")
  }))

it.effect("rejects a token with the wrong audience", () =>
  Effect.gen(function*() {
    const token = yield* Effect.promise(() => sign({ sub: "user-1" }, { audience: "other-client" }))
    expect(yield* errorTag(runVerify(token))).toBe("InvalidAudience")
  }))

it.effect("rejects an expired token", () =>
  Effect.gen(function*() {
    const token = yield* Effect.promise(() =>
      sign({ sub: "user-1" }, { expiration: Math.floor(Date.now() / 1000) - 3600 })
    )
    expect(yield* errorTag(runVerify(token))).toBe("ExpiredToken")
  }))

it.effect("rejects a token whose nonce does not echo the expected nonce", () =>
  Effect.gen(function*() {
    const token = yield* Effect.promise(() => sign({ sub: "user-1", nonce: "nonce-sent" }))
    expect(yield* errorTag(runVerify(token, { nonce: "nonce-expected" }))).toBe("NonceMismatch")
  }))

it.effect("rejects an HS256 token against an RS256-only provider (key confusion)", () =>
  Effect.gen(function*() {
    const key = new TextEncoder().encode("symmetric-shared-secret")
    const token = yield* Effect.promise(() =>
      sign({ sub: "user-1" }, { alg: "HS256", key, kid: undefined })
    )
    expect(yield* errorTag(runVerify(token))).toBe("AlgorithmNotAllowed")
  }))