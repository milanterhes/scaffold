import { expect, it } from "@effect/vitest"
import { NodeCrypto } from "@effect/platform-node"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpClientResponse, Headers } from "effect/unstable/http"
import { createHash } from "node:crypto"
import { IdTokenVerifier } from "../jwt.ts"
import type { IdTokenClaims, VerifyIdTokenOptions } from "../jwt.ts"
import {
  createAuthorizationURL,
  generateNonce,
  generatePkce,
  generateState,
  validateAuthorizationCode
} from "./protocol.ts"
import type { OAuth2Provider, OidcProvider } from "./protocol.ts"

const DISCOVERY_PATH = "/.well-known/openid-configuration"
const AUTHORIZE_PATH = "/oauth/authorize"
const TOKEN_PATH = "/oauth/token"
const USERINFO_PATH = "/oauth/userinfo"
const PROFILE_PATH = "/user"

const ISSUER = "https://fake.example.com"

const discoveryDocument = {
  issuer: ISSUER,
  authorization_endpoint: `https://fake.example.com${AUTHORIZE_PATH}`,
  token_endpoint: `https://fake.example.com${TOKEN_PATH}`,
  userinfo_endpoint: `https://fake.example.com${USERINFO_PATH}`,
  jwks_uri: "https://fake.example.com/.well-known/jwks.json"
}

const oidcProvider: OidcProvider = {
  kind: "oidc",
  clientId: "client-id",
  clientSecret: "client-secret",
  scopes: ["openid", "email"],
  redirectUri: "https://app.example.com/callback",
  discoveryUrl: `https://fake.example.com${DISCOVERY_PATH}`,
  algorithms: ["RS256"],
  fetchUserInfo: true
}

const oauth2Provider: OAuth2Provider = {
  kind: "oauth2",
  clientId: "client-id",
  clientSecret: "client-secret",
  scopes: ["read:user"],
  redirectUri: "https://app.example.com/callback",
  authorizationEndpoint: `https://fake.example.com${AUTHORIZE_PATH}`,
  tokenEndpoint: `https://fake.example.com${TOKEN_PATH}`,
  profileEndpoint: `https://fake.example.com${PROFILE_PATH}`
}

const AUTH_CODE = "auth-code"
const ACCESS_TOKEN = "access-token-123"

const readBody = (request: HttpClientRequest.HttpClientRequest): string => {
  const body = request.body
  if (body instanceof HttpBody.Uint8Array) return new TextDecoder().decode(body.body)
  return ""
}

interface FakeTokenResponse {
  readonly verifier: string | null
  readonly code: string | null
  readonly authorizationHeader: string | null
}

interface FakeProvider {
  readonly client: HttpClient.HttpClient
  readonly lastTokenRequest: () => FakeTokenResponse
}

const makeFakeProvider = (expectedVerifier: string): FakeProvider => {
  let lastTokenRequest: FakeTokenResponse = { verifier: null, code: null, authorizationHeader: null }
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

  const client = HttpClient.make((request) => {
    const url = new URL(request.url)
    let response: Response
    if (request.method === "GET" && url.pathname === DISCOVERY_PATH) {
      response = json(discoveryDocument, 200)
    } else if (request.method === "POST" && url.pathname === TOKEN_PATH) {
      const params = new URLSearchParams(readBody(request))
      lastTokenRequest = {
        verifier: params.get("code_verifier"),
        code: params.get("code"),
        authorizationHeader: null
      }
      if (params.get("code") !== AUTH_CODE || params.get("code_verifier") !== expectedVerifier) {
        response = json({ error: "invalid_grant" }, 400)
      } else {
        response = json({
          access_token: ACCESS_TOKEN,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "refresh-token-123",
          scope: "openid email",
          id_token: "fake-id-token"
        }, 200)
      }
    } else if (request.method === "GET" && url.pathname === USERINFO_PATH) {
      const auth = Option.getOrElse(Headers.get(request.headers, "authorization"), () => "")
      lastTokenRequest = { ...lastTokenRequest, authorizationHeader: auth }
      if (auth !== `Bearer ${ACCESS_TOKEN}`) {
        response = json({ error: "unauthorized" }, 401)
      } else {
        response = json({ sub: "user-1", email: "alice@example.com", email_verified: true }, 200)
      }
    } else if (request.method === "GET" && url.pathname === PROFILE_PATH) {
      const auth = Option.getOrElse(Headers.get(request.headers, "authorization"), () => "")
      lastTokenRequest = { ...lastTokenRequest, authorizationHeader: auth }
      if (auth !== `Bearer ${ACCESS_TOKEN}`) {
        response = json({ error: "unauthorized" }, 401)
      } else {
        response = json({ login: "alice", id: 123, name: "Alice" }, 200)
      }
    } else {
      response = json({ error: "not found" }, 404)
    }
    return Effect.succeed(HttpClientResponse.fromWeb(request, response))
  })

  return { client, lastTokenRequest: () => lastTokenRequest }
}

const FakeHttpLayer = (client: HttpClient.HttpClient): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(HttpClient.HttpClient, client)

const recordedVerifyCalls: Array<VerifyIdTokenOptions> = []
const FakeIdTokenVerifier: Layer.Layer<IdTokenVerifier> = Layer.succeed(
  IdTokenVerifier,
  IdTokenVerifier.of({
    verifyIdToken: (verifyOptions, _idToken) => {
      recordedVerifyCalls.push(verifyOptions)
      return Effect.succeed<IdTokenClaims>({
        sub: "user-1",
        email: "alice@example.com",
        email_verified: true,
        ...(verifyOptions.nonce !== undefined ? { nonce: verifyOptions.nonce } : {})
      })
    }
  })
)

const errorTag = <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E, never>
): Effect.Effect<string | undefined, never> =>
  effect.pipe(
    Effect.exit,
    Effect.map((exit) => {
      if (Exit.isSuccess(exit)) return undefined
      const failure = Cause.findErrorOption(exit.cause)
      return Option.isSome(failure) ? failure.value._tag : undefined
    })
  )

const withCrypto = (effect: Effect.Effect<unknown, never, never>): Effect.Effect<unknown, never, never> =>
  effect.pipe(Effect.provide(NodeCrypto.layer))

it.effect("generatePkce produces an S256 verifier/challenge pair", () =>
  withCrypto(
    Effect.gen(function*() {
      const pair = yield* generatePkce()
      expect(pair.verifier).toHaveLength(43)
      expect(pair.challenge).toHaveLength(43)
      const expectedChallenge = createHash("sha256").update(pair.verifier, "utf8").digest("base64url")
      expect(pair.challenge).toBe(expectedChallenge)
    })
  ))

it.effect("generateState and generateNonce produce distinct values", () =>
  withCrypto(
    Effect.gen(function*() {
      const state = yield* generateState()
      const otherState = yield* generateState()
      const nonce = yield* generateNonce()
      expect(state).toHaveLength(43)
      expect(state).not.toBe(otherState)
      expect(nonce).toHaveLength(43)
    })
  ))

it.effect("createAuthorizationURL (OIDC) resolves discovery and encodes PKCE + state", () =>
  Effect.gen(function*() {
    const pair = yield* generatePkce().pipe(Effect.provide(NodeCrypto.layer))
    const url = yield* createAuthorizationURL(oidcProvider, {
      state: "state-1",
      codeChallenge: pair.challenge,
      nonce: "nonce-1"
    })
    expect(url.host).toBe("fake.example.com")
    expect(url.pathname).toBe(AUTHORIZE_PATH)
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("client_id")).toBe("client-id")
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/callback")
    expect(url.searchParams.get("scope")).toBe("openid email")
    expect(url.searchParams.get("state")).toBe("state-1")
    expect(url.searchParams.get("code_challenge")).toBe(pair.challenge)
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("nonce")).toBe("nonce-1")
  }).pipe(
    Effect.provide(FakeHttpLayer(makeFakeProvider("").client))
  ))

it.effect("createAuthorizationURL (OAuth2) builds the authorize URL", () =>
  Effect.gen(function*() {
    const url = yield* createAuthorizationURL(oauth2Provider, {
      state: "state-1",
      codeChallenge: "challenge"
    })
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("client_id")).toBe("client-id")
    expect(url.searchParams.get("scope")).toBe("read:user")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("nonce")).toBeNull()
  }))

it.effect("validateAuthorizationCode (OIDC) exchanges, verifies the id_token, and fetches userinfo", () =>
  Effect.gen(function*() {
    recordedVerifyCalls.length = 0
    const pair = yield* generatePkce().pipe(Effect.provide(NodeCrypto.layer))
    const fake = makeFakeProvider(pair.verifier)
    const result = yield* validateAuthorizationCode(oidcProvider, AUTH_CODE, {
      verifier: pair.verifier,
      state: "state-1",
      receivedState: "state-1",
      nonce: "nonce-1"
    }).pipe(
      Effect.provide(FakeHttpLayer(fake.client)),
      Effect.provide(FakeIdTokenVerifier)
    )
    expect(result.kind).toBe("oidc")
    if (result.kind === "oidc") {
      expect(result.tokens.accessToken).toBe(ACCESS_TOKEN)
      expect(result.tokens.refreshToken).toBe("refresh-token-123")
      expect(result.tokens.expiresIn).toBe(3600)
      expect(result.idToken).toBe("fake-id-token")
      expect(result.claims.sub).toBe("user-1")
      expect(result.userinfo).toEqual({ sub: "user-1", email: "alice@example.com", email_verified: true })
    }
    const tokenRequest = fake.lastTokenRequest()
    expect(tokenRequest.verifier).toBe(pair.verifier)
    expect(tokenRequest.code).toBe(AUTH_CODE)
    expect(tokenRequest.authorizationHeader).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(recordedVerifyCalls).toHaveLength(1)
    const verifyOptions = recordedVerifyCalls[0]
    expect(verifyOptions?.jwksUri).toBe("https://fake.example.com/.well-known/jwks.json")
    expect(verifyOptions?.issuer).toBe(ISSUER)
    expect(verifyOptions?.audience).toBe("client-id")
    expect(verifyOptions?.algorithms).toEqual(["RS256"])
    expect(verifyOptions?.nonce).toBe("nonce-1")
  }))

it.effect("validateAuthorizationCode fails when the PKCE verifier is wrong", () =>
  Effect.gen(function*() {
    const fake = makeFakeProvider("the-real-verifier")
    const outcome = yield* errorTag(
      validateAuthorizationCode(oidcProvider, AUTH_CODE, {
        verifier: "the-wrong-verifier",
        state: "state-1",
        receivedState: "state-1"
      }).pipe(
        Effect.provide(FakeHttpLayer(fake.client)),
        Effect.provide(FakeIdTokenVerifier)
      )
    )
    expect(outcome).toBe("TokenExchangeFailed")
  }))

it.effect("validateAuthorizationCode rejects a state echo mismatch", () =>
  Effect.gen(function*() {
    const fake = makeFakeProvider("verifier")
    const outcome = yield* errorTag(
      validateAuthorizationCode(oauth2Provider, AUTH_CODE, {
        verifier: "verifier",
        state: "state-sent",
        receivedState: "state-echoed-differently"
      }).pipe(
        Effect.provide(FakeHttpLayer(fake.client)),
        Effect.provide(FakeIdTokenVerifier)
      )
    )
    expect(outcome).toBe("StateMismatch")
    expect(fake.lastTokenRequest().code).toBeNull()
  }))

it.effect("validateAuthorizationCode (OAuth2) exchanges the code and fetches the profile", () =>
  Effect.gen(function*() {
    const pair = yield* generatePkce().pipe(Effect.provide(NodeCrypto.layer))
    const fake = makeFakeProvider(pair.verifier)
    const result = yield* validateAuthorizationCode(oauth2Provider, AUTH_CODE, {
      verifier: pair.verifier,
      state: "state-1",
      receivedState: "state-1"
    }).pipe(
      Effect.provide(FakeHttpLayer(fake.client)),
      Effect.provide(FakeIdTokenVerifier)
    )
    expect(result.kind).toBe("oauth2")
    if (result.kind === "oauth2") {
      expect(result.tokens.accessToken).toBe(ACCESS_TOKEN)
      expect(result.profile).toEqual({ login: "alice", id: 123, name: "Alice" })
    }
    expect(fake.lastTokenRequest().authorizationHeader).toBe(`Bearer ${ACCESS_TOKEN}`)
  }))