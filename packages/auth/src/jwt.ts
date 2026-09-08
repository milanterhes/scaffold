import { Context, Effect, Layer, Option } from "effect"
import { createRemoteJWKSet, decodeProtectedHeader, errors, jwtVerify } from "jose"
import type { JWTPayload } from "jose"

/**
 * The claims of a verified OIDC `id_token`. `sub` is required; the rest are
 * the standard OIDC claims plus any provider-specific extras (kept under the
 * index signature so custom claims survive verification untouched).
 */
export type IdTokenClaims = {
  readonly sub: string
  readonly iss?: string
  readonly aud?: string | readonly string[]
  readonly exp?: number
  readonly iat?: number
  readonly nbf?: number
  readonly nonce?: string
  readonly email?: string
  readonly email_verified?: boolean
  readonly name?: string
  readonly picture?: string
  readonly [claim: string]: unknown
}

export interface VerifyIdTokenOptions {
  readonly jwksUri: string
  readonly issuer: string
  readonly audience: string
  readonly algorithms: ReadonlyArray<string>
  readonly nonce?: string
}

export type IdTokenVerificationError =
  | { readonly _tag: "MalformedToken"; readonly message: string }
  | { readonly _tag: "AlgorithmNotAllowed"; readonly message: string }
  | { readonly _tag: "InvalidSignature"; readonly message: string }
  | { readonly _tag: "InvalidIssuer"; readonly message: string }
  | { readonly _tag: "InvalidAudience"; readonly message: string }
  | { readonly _tag: "InvalidClaims"; readonly message: string }
  | { readonly _tag: "ExpiredToken"; readonly message: string }
  | { readonly _tag: "NonceMismatch" }
  | { readonly _tag: "JwksUnavailable"; readonly message: string }

/**
 * The one place JWT/JWKS crypto is delegated to `jose`. Production uses
 * discovery-driven remote JWKS (`createRemoteJWKSet`), enforces signature +
 * `iss` + `aud` + `exp` + pinned algorithms, and binds the OIDC `nonce`.
 */
export class IdTokenVerifier extends Context.Service<IdTokenVerifier, {
  readonly verifyIdToken: (
    options: VerifyIdTokenOptions,
    idToken: string
  ) => Effect.Effect<IdTokenClaims, IdTokenVerificationError>
}>()("app/auth/IdTokenVerifier") {}

export type IdTokenVerifierService = IdTokenVerifier["Service"]

const readAlgorithm = (idToken: string): Option.Option<string> => {
  try {
    return Option.some(decodeProtectedHeader(idToken).alg ?? "")
  } catch {
    return Option.none()
  }
}

const mapJoseError = (error: unknown): IdTokenVerificationError => {
  if (error instanceof errors.JWTExpired) return { _tag: "ExpiredToken", message: error.message }
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === "iss") return { _tag: "InvalidIssuer", message: error.message }
    if (error.claim === "aud") return { _tag: "InvalidAudience", message: error.message }
    return { _tag: "InvalidClaims", message: error.message }
  }
  if (error instanceof errors.JOSEAlgNotAllowed) return { _tag: "AlgorithmNotAllowed", message: error.message }
  if (error instanceof errors.JWSSignatureVerificationFailed) {
    return { _tag: "InvalidSignature", message: error.message }
  }
  if (error instanceof errors.JWKSNoMatchingKey) return { _tag: "InvalidSignature", message: error.message }
  if (error instanceof errors.JWKSTimeout) return { _tag: "JwksUnavailable", message: error.message }
  if (error instanceof errors.JWTInvalid) return { _tag: "MalformedToken", message: error.message }
  return { _tag: "MalformedToken", message: error instanceof Error ? error.message : String(error) }
}

const toClaims = (payload: JWTPayload): IdTokenClaims => ({
  sub: typeof payload.sub === "string" ? payload.sub : "",
  ...payload
})

/**
 * Live implementation: `createRemoteJWKSet` (one key set per `jwksUri`, so
 * key rotation + caching survive across verifications) + `jwtVerify` with the
 * algorithms pinned to what the provider advertises. The algorithm is checked
 * from the header first so an off-pinned `alg` (e.g. `HS256` against an
 * `RS256`-only provider, or `none`) fails as `AlgorithmNotAllowed` before any
 * key material is touched.
 */
export const IdTokenVerifierLive: Layer.Layer<IdTokenVerifier> = Layer.effect(
  IdTokenVerifier,
  Effect.gen(function*() {
    const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()
    const getJwks = (jwksUri: string): ReturnType<typeof createRemoteJWKSet> => {
      let jwks = jwksCache.get(jwksUri)
      if (jwks === undefined) {
        jwks = createRemoteJWKSet(new URL(jwksUri))
        jwksCache.set(jwksUri, jwks)
      }
      return jwks
    }
    return IdTokenVerifier.of({
      verifyIdToken: (options, idToken) =>
        Effect.gen(function*() {
          const algOption = readAlgorithm(idToken)
          if (Option.isNone(algOption) || !options.algorithms.includes(algOption.value)) {
            return yield* Effect.fail<IdTokenVerificationError>({
              _tag: "AlgorithmNotAllowed",
              message: `token alg "${Option.getOrElse(algOption, () => "unknown")}" not allowed (expected [${options.algorithms.join(", ")}])`
            })
          }
          const { payload } = yield* Effect.tryPromise({
            try: () =>
              jwtVerify(idToken, getJwks(options.jwksUri), {
                issuer: options.issuer,
                audience: options.audience,
                algorithms: [...options.algorithms]
              }),
            catch: (error) => mapJoseError(error)
          })
          if (options.nonce !== undefined && payload.nonce !== options.nonce) {
            return yield* Effect.fail<IdTokenVerificationError>({ _tag: "NonceMismatch" })
          }
          return toClaims(payload)
        })
    })
  })
)

/**
 * Test implementation: short-circuits crypto and returns canned claims, echoing
 * the requested nonce when one is supplied. The OAuth flow's tests use this so
 * they exercise the protocol without spinning up a real JWKS.
 */
export const IdTokenVerifierTest: Layer.Layer<IdTokenVerifier> = Layer.succeed(
  IdTokenVerifier,
  IdTokenVerifier.of({
    verifyIdToken: (options, _idToken) =>
      Effect.succeed<IdTokenClaims>({
        sub: "test-subject",
        ...(options.nonce !== undefined ? { nonce: options.nonce } : {})
      })
  })
)