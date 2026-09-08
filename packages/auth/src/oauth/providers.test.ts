import { expect, it } from "@effect/vitest"
import { NodeCrypto } from "@effect/platform-node"
import { Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpClientResponse, Headers } from "effect/unstable/http"
import { IdTokenVerifier } from "../jwt.ts"
import type { IdTokenClaims } from "../jwt.ts"
import { createAuthorizationURL, DEFAULT_OAUTH_USER_AGENT, generatePkce, validateAuthorizationCode } from "./protocol.ts"
import { googleProvider, googleIdentity } from "./providers/google.ts"
import { linkedinProvider, linkedinIdentity } from "./providers/linkedin.ts"
import { githubProvider, githubIdentity } from "./providers/github.ts"
import {
  GITHUB_AUTHORIZE_URL,
  GITHUB_PROFILE_URL,
  GITHUB_TOKEN_URL
} from "./providers/github.ts"
import { GOOGLE_DISCOVERY_URL } from "./providers/google.ts"

const AUTH_CODE = "auth-code"
const ACCESS_TOKEN = "access-token-123"

const DISCOVERY_PATH = "/.well-known/openid-configuration"
const LINKEDIN_DISCOVERY_PATH = "/oauth/.well-known/openid-configuration"

const GOOGLE_DISCOVERY = {
  issuer: "https://accounts.google.com",
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token",
  userinfo_endpoint: "https://openidconnect.googleapis.com/v1/userinfo",
  jwks_uri: "https://www.googleapis.com/oauth2/v3/certs"
}
const GOOGLE_TOKEN_PATH = "/token"
const GOOGLE_USERINFO_PATH = "/v1/userinfo"

const LINKEDIN_DISCOVERY = {
  issuer: "https://www.linkedin.com",
  authorization_endpoint: "https://www.linkedin.com/oauth/v2/authorization",
  token_endpoint: "https://www.linkedin.com/oauth/v2/accessToken",
  userinfo_endpoint: "https://api.linkedin.com/v2/userinfo",
  jwks_uri: "https://www.linkedin.com/oauth/openid/jwks"
}
const LINKEDIN_TOKEN_PATH = "/oauth/v2/accessToken"

const GITHUB_TOKEN_PATH = "/login/oauth/access_token"
const GITHUB_PROFILE_PATH = "/user"
const GITHUB_EMAILS_PATH = "/user/emails"

const readBody = (request: HttpClientRequest.HttpClientRequest): string => {
  const body = request.body
  if (body instanceof HttpBody.Uint8Array) return new TextDecoder().decode(body.body)
  return ""
}

interface RecordedRequest {
  readonly method: string
  readonly pathname: string
  readonly body: string
  readonly authorizationHeader: string | null
  readonly userAgentHeader: string | null
}

interface FakeRoute {
  readonly method: "GET" | "POST"
  readonly pathname: string
  readonly handler: (request: RecordedRequest) => { readonly status: number; readonly body: unknown }
}

const json = (body: unknown, status: number): { readonly status: number; readonly body: unknown } => ({ status, body })

const makeFakeHttp = (routes: ReadonlyArray<FakeRoute>) => {
  const requests: Array<RecordedRequest> = []
  const client = HttpClient.make((request) => {
    const url = new URL(request.url)
    const recorded: RecordedRequest = {
      method: request.method,
      pathname: url.pathname,
      body: readBody(request),
      authorizationHeader: Option.getOrElse(Headers.get(request.headers, "authorization"), () => null),
      userAgentHeader: Option.getOrElse(Headers.get(request.headers, "user-agent"), () => null)
    }
    requests.push(recorded)
    const route = routes.find((r) => r.method === recorded.method && r.pathname === recorded.pathname)
    const { status, body } = route !== undefined ? route.handler(recorded) : json({ error: "not found" }, 404)
    const response = new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    })
    return Effect.succeed(HttpClientResponse.fromWeb(request, response))
  })
  return { client, requests }
}

const tokenRoute = (pathname: string, expectedVerifier: string, tokenBody: Record<string, unknown>): FakeRoute => ({
  method: "POST",
  pathname,
  handler: (request) => {
    const params = new URLSearchParams(request.body)
    if (params.get("code") !== AUTH_CODE || params.get("code_verifier") !== expectedVerifier) {
      return json({ error: "invalid_grant" }, 400)
    }
    return json(tokenBody, 200)
  }
})

const bearerRoute = (pathname: string, body: unknown): FakeRoute => ({
  method: "GET",
  pathname,
  handler: (request) =>
    request.authorizationHeader === `Bearer ${ACCESS_TOKEN}` ? json(body, 200) : json({ error: "unauthorized" }, 401)
})

const googleFake = (expectedVerifier: string) =>
  makeFakeHttp([
    { method: "GET", pathname: DISCOVERY_PATH, handler: () => json(GOOGLE_DISCOVERY, 200) },
    tokenRoute(GOOGLE_TOKEN_PATH, expectedVerifier, {
      access_token: ACCESS_TOKEN,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid email profile",
      id_token: "fake-google-id-token"
    }),
    bearerRoute(GOOGLE_USERINFO_PATH, {
      sub: "user-1",
      email: "alice@gmail.com",
      email_verified: true,
      name: "Alice",
      picture: "https://pic"
    })
  ])

const linkedinFake = (expectedVerifier: string) =>
  makeFakeHttp([
    { method: "GET", pathname: LINKEDIN_DISCOVERY_PATH, handler: () => json(LINKEDIN_DISCOVERY, 200) },
    tokenRoute(LINKEDIN_TOKEN_PATH, expectedVerifier, {
      access_token: ACCESS_TOKEN,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid profile email",
      id_token: "fake-linkedin-id-token"
    })
  ])

const githubFake = (expectedVerifier: string) =>
  makeFakeHttp([
    tokenRoute(GITHUB_TOKEN_PATH, expectedVerifier, {
      access_token: ACCESS_TOKEN,
      token_type: "Bearer",
      scope: "read:user user:email"
    }),
    bearerRoute(GITHUB_PROFILE_PATH, {
      id: 42,
      login: "alice",
      name: "Alice",
      email: null,
      avatar_url: "https://avatars/1"
    }),
    bearerRoute(GITHUB_EMAILS_PATH, [
      { email: "noreply@users.noreply.github.com", primary: false, verified: true, visibility: null },
      { email: "alice@example.com", primary: true, verified: true, visibility: "public" }
    ])
  ])

const FakeHttpLayer = (client: HttpClient.HttpClient): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(HttpClient.HttpClient, client)

const makeFakeIdTokenVerifier = (claims: Partial<IdTokenClaims>): Layer.Layer<IdTokenVerifier> =>
  Layer.succeed(
    IdTokenVerifier,
    IdTokenVerifier.of({
      verifyIdToken: (options, _idToken) =>
        Effect.succeed<IdTokenClaims>({
          sub: "user-1",
          ...claims,
          ...(options.nonce !== undefined ? { nonce: options.nonce } : {})
        })
    })
  )

const google = googleProvider({
  clientId: "google-client",
  clientSecret: "google-secret",
  redirectUri: "https://app.example.com/callback"
})

const linkedin = linkedinProvider({
  clientId: "li-client",
  clientSecret: "li-secret",
  redirectUri: "https://app.example.com/callback"
})

const github = githubProvider({
  clientId: "gh-client",
  clientSecret: "gh-secret",
  redirectUri: "https://app.example.com/callback"
})

it("Google: provider config pins OIDC discovery, scopes, and algorithms", () => {
  expect(google.kind).toBe("oidc")
  expect(google.discoveryUrl).toBe(GOOGLE_DISCOVERY_URL)
  expect(google.scopes).toEqual(["openid", "email", "profile"])
  expect(google.algorithms).toEqual(["RS256", "ES256"])
  expect(google.fetchUserInfo).toBe(true)
})

it.effect("Google: authorization URL resolves discovery and carries OIDC params", () =>
  Effect.gen(function*() {
    const pair = yield* generatePkce().pipe(Effect.provide(NodeCrypto.layer))
    const fake = googleFake("")
    const url = yield* createAuthorizationURL(google, {
      state: "state-1",
      codeChallenge: pair.challenge,
      nonce: "nonce-1"
    }).pipe(Effect.provide(FakeHttpLayer(fake.client)))
    expect(url.host).toBe("accounts.google.com")
    expect(url.pathname).toBe("/o/oauth2/v2/auth")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("client_id")).toBe("google-client")
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/callback")
    expect(url.searchParams.get("scope")).toBe("openid email profile")
    expect(url.searchParams.get("state")).toBe("state-1")
    expect(url.searchParams.get("code_challenge")).toBe(pair.challenge)
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("nonce")).toBe("nonce-1")
  }))

it("LinkedIn: provider config pins RS256 and the email-optional scopes", () => {
  expect(linkedin.kind).toBe("oidc")
  expect(linkedin.algorithms).toEqual(["RS256"])
  expect(linkedin.scopes).toEqual(["openid", "profile", "email"])
  expect(linkedin.fetchUserInfo).toBe(false)
})

it.effect("LinkedIn: authorization URL resolves discovery and carries OIDC params", () =>
  Effect.gen(function*() {
    const pair = yield* generatePkce().pipe(Effect.provide(NodeCrypto.layer))
    const fake = linkedinFake("")
    const url = yield* createAuthorizationURL(linkedin, {
      state: "state-1",
      codeChallenge: pair.challenge,
      nonce: "nonce-1"
    }).pipe(Effect.provide(FakeHttpLayer(fake.client)))
    expect(url.host).toBe("www.linkedin.com")
    expect(url.pathname).toBe("/oauth/v2/authorization")
    expect(url.searchParams.get("scope")).toBe("openid profile email")
    expect(url.searchParams.get("state")).toBe("state-1")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("nonce")).toBe("nonce-1")
  }))

it("GitHub: provider config is OAuth2-only with fixed endpoints", () => {
  expect(github.kind).toBe("oauth2")
  expect(github.authorizationEndpoint).toBe(GITHUB_AUTHORIZE_URL)
  expect(github.tokenEndpoint).toBe(GITHUB_TOKEN_URL)
  expect(github.profileEndpoint).toBe(GITHUB_PROFILE_URL)
})

it.effect("GitHub: authorization URL builds the OAuth2 authorize URL with PKCE", () =>
  Effect.gen(function*() {
    const pair = yield* generatePkce().pipe(Effect.provide(NodeCrypto.layer))
    const url = yield* createAuthorizationURL(github, {
      state: "state-1",
      codeChallenge: pair.challenge
    })
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("client_id")).toBe("gh-client")
    expect(url.searchParams.get("scope")).toBe("read:user user:email")
    expect(url.searchParams.get("state")).toBe("state-1")
    expect(url.searchParams.get("code_challenge")).toBe(pair.challenge)
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("nonce")).toBeNull()
  }))

it("Google identity maps verified claims into the canonical shape", () => {
  expect(
    googleIdentity({ sub: "google-sub-1", email: "alice@gmail.com", email_verified: true, name: "Alice", picture: "https://pic" })
  ).toEqual({
    provider: "google",
    providerAccountId: "google-sub-1",
    email: "alice@gmail.com",
    emailVerified: true,
    name: "Alice",
    picture: "https://pic"
  })
})

it("Google identity resolves to a subject even without email claims", () => {
  const identity = googleIdentity({ sub: "google-sub-1" })
  expect(identity.providerAccountId).toBe("google-sub-1")
  expect(identity.email).toBeNull()
  expect(identity.emailVerified).toBe(false)
  expect(identity.name).toBeNull()
})

it("LinkedIn identity resolves subject + name without an email", () => {
  const identity = linkedinIdentity({ sub: "li-sub-1", name: "Bob Jones" })
  expect(identity.provider).toBe("linkedin")
  expect(identity.providerAccountId).toBe("li-sub-1")
  expect(identity.name).toBe("Bob Jones")
  expect(identity.email).toBeNull()
  expect(identity.emailVerified).toBe(false)
  expect(identity.picture).toBeNull()
})

it("LinkedIn identity surfaces email and the verification flag when present", () => {
  const identity = linkedinIdentity({ sub: "li-sub-1", name: "Bob Jones", email: "bob@example.com", email_verified: true })
  expect(identity.email).toBe("bob@example.com")
  expect(identity.emailVerified).toBe(true)
})

it.effect("GitHub identity resolves the primary verified email from /user/emails", () =>
  Effect.gen(function*() {
    const fake = githubFake("")
    const identity = yield* githubIdentity(
      { id: 42, login: "alice", name: "Alice", email: null, avatar_url: "https://avatars/1" },
      ACCESS_TOKEN,
      DEFAULT_OAUTH_USER_AGENT
    ).pipe(Effect.provide(FakeHttpLayer(fake.client)))
    expect(identity).toEqual({
      provider: "github",
      providerAccountId: "42",
      email: "alice@example.com",
      emailVerified: true,
      name: "Alice",
      picture: "https://avatars/1"
    })
    expect(fake.requests.some((r) => r.pathname === GITHUB_EMAILS_PATH)).toBe(true)
    expect(fake.requests.filter((r) => r.pathname === GITHUB_EMAILS_PATH).every((r) => r.userAgentHeader === DEFAULT_OAUTH_USER_AGENT)).toBe(true)
  }))

it.effect("GitHub identity tolerates a null profile email and an empty email list", () =>
  Effect.gen(function*() {
    const fake = makeFakeHttp([bearerRoute(GITHUB_EMAILS_PATH, [])])
    const identity = yield* githubIdentity(
      { id: 7, login: "no-email", email: null, name: null },
      ACCESS_TOKEN,
      DEFAULT_OAUTH_USER_AGENT
    ).pipe(Effect.provide(FakeHttpLayer(fake.client)))
    expect(identity.providerAccountId).toBe("7")
    expect(identity.email).toBeNull()
    expect(identity.emailVerified).toBe(false)
    expect(identity.name).toBeNull()
    expect(fake.requests.filter((r) => r.pathname === GITHUB_EMAILS_PATH).every((r) => r.userAgentHeader === DEFAULT_OAUTH_USER_AGENT)).toBe(true)
  }))

it.effect("Google: full login round-trip surfaces sub + verified email", () =>
  Effect.gen(function*() {
    const pair = yield* generatePkce().pipe(Effect.provide(NodeCrypto.layer))
    const fake = googleFake(pair.verifier)
    const result = yield* validateAuthorizationCode(google, AUTH_CODE, {
      verifier: pair.verifier,
      state: "state-1",
      receivedState: "state-1",
      nonce: "nonce-1"
    }).pipe(
      Effect.provide(FakeHttpLayer(fake.client)),
      Effect.provide(makeFakeIdTokenVerifier({ email: "alice@gmail.com", email_verified: true, name: "Alice", picture: "https://pic" }))
    )
    expect(result.kind).toBe("oidc")
    if (result.kind === "oidc") {
      const identity = googleIdentity(result.claims)
      expect(identity.providerAccountId).toBe("user-1")
      expect(identity.email).toBe("alice@gmail.com")
      expect(identity.emailVerified).toBe(true)
      expect(identity.name).toBe("Alice")
    }
    const tokenRequest = fake.requests.find((r) => r.method === "POST" && r.pathname === GOOGLE_TOKEN_PATH)
    expect(tokenRequest).toBeDefined()
    expect(new URLSearchParams(tokenRequest?.body ?? "").get("code_verifier")).toBe(pair.verifier)
    const userinfoRequest = fake.requests.find((r) => r.method === "GET" && r.pathname === GOOGLE_USERINFO_PATH)
    expect(userinfoRequest?.authorizationHeader).toBe(`Bearer ${ACCESS_TOKEN}`)
  }))

it.effect("LinkedIn: round-trip without email still resolves subject + name", () =>
  Effect.gen(function*() {
    const pair = yield* generatePkce().pipe(Effect.provide(NodeCrypto.layer))
    const fake = linkedinFake(pair.verifier)
    const result = yield* validateAuthorizationCode(linkedin, AUTH_CODE, {
      verifier: pair.verifier,
      state: "state-1",
      receivedState: "state-1",
      nonce: "nonce-1"
    }).pipe(
      Effect.provide(FakeHttpLayer(fake.client)),
      Effect.provide(makeFakeIdTokenVerifier({ name: "Bob Jones" }))
    )
    expect(result.kind).toBe("oidc")
    if (result.kind === "oidc") {
      const identity = linkedinIdentity(result.claims)
      expect(identity.providerAccountId).toBe("user-1")
      expect(identity.name).toBe("Bob Jones")
      expect(identity.email).toBeNull()
      expect(identity.emailVerified).toBe(false)
    }
  }))

it.effect("LinkedIn: round-trip with email surfaces email + verification flag", () =>
  Effect.gen(function*() {
    const pair = yield* generatePkce().pipe(Effect.provide(NodeCrypto.layer))
    const fake = linkedinFake(pair.verifier)
    const result = yield* validateAuthorizationCode(linkedin, AUTH_CODE, {
      verifier: pair.verifier,
      state: "state-1",
      receivedState: "state-1",
      nonce: "nonce-1"
    }).pipe(
      Effect.provide(FakeHttpLayer(fake.client)),
      Effect.provide(makeFakeIdTokenVerifier({ name: "Bob Jones", email: "bob@example.com", email_verified: true }))
    )
    if (result.kind === "oidc") {
      const identity = linkedinIdentity(result.claims)
      expect(identity.email).toBe("bob@example.com")
      expect(identity.emailVerified).toBe(true)
    }
  }))

it.effect("GitHub: OAuth2 round-trip exchanges the code with PKCE and resolves identity", () =>
  Effect.gen(function*() {
    const pair = yield* generatePkce().pipe(Effect.provide(NodeCrypto.layer))
    const fake = githubFake(pair.verifier)
    const result = yield* validateAuthorizationCode(github, AUTH_CODE, {
      verifier: pair.verifier,
      state: "state-1",
      receivedState: "state-1"
    }).pipe(Effect.provide(FakeHttpLayer(fake.client)))
    expect(result.kind).toBe("oauth2")
    if (result.kind === "oauth2") {
      const identity = yield* githubIdentity(result.profile, result.tokens.accessToken, DEFAULT_OAUTH_USER_AGENT).pipe(
        Effect.provide(FakeHttpLayer(fake.client))
      )
      expect(identity.provider).toBe("github")
      expect(identity.providerAccountId).toBe("42")
      expect(identity.email).toBe("alice@example.com")
      expect(identity.emailVerified).toBe(true)
      expect(identity.name).toBe("Alice")
    }
    const tokenRequest = fake.requests.find((r) => r.method === "POST" && r.pathname === GITHUB_TOKEN_PATH)
    const params = new URLSearchParams(tokenRequest?.body ?? "")
    expect(params.get("code_verifier")).toBe(pair.verifier)
    expect(params.get("code")).toBe(AUTH_CODE)
    const apiRequests = fake.requests.filter((r) => r.pathname === GITHUB_PROFILE_PATH || r.pathname === GITHUB_EMAILS_PATH)
    expect(apiRequests.length).toBeGreaterThan(0)
    expect(apiRequests.every((r) => r.userAgentHeader === DEFAULT_OAUTH_USER_AGENT)).toBe(true)
  }))

it.effect("GitHub: a provider-level userAgent overrides the library default on API requests", () =>
  Effect.gen(function*() {
    const pair = yield* generatePkce().pipe(Effect.provide(NodeCrypto.layer))
    const provider = githubProvider({
      clientId: "gh-client",
      clientSecret: "gh-secret",
      redirectUri: "https://app.example.com/callback",
      userAgent: "my-app/1.2.3"
    })
    const fake = githubFake(pair.verifier)
    yield* validateAuthorizationCode(provider, AUTH_CODE, {
      verifier: pair.verifier,
      state: "state-1",
      receivedState: "state-1"
    }).pipe(Effect.provide(FakeHttpLayer(fake.client)))
    const apiRequests = fake.requests.filter((r) => r.pathname === GITHUB_PROFILE_PATH || r.pathname === GITHUB_EMAILS_PATH)
    expect(apiRequests.length).toBeGreaterThan(0)
    expect(apiRequests.every((r) => r.userAgentHeader === "my-app/1.2.3")).toBe(true)
  }))