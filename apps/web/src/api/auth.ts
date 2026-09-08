import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { AuthApi } from "@app/auth/api"

export interface AuthUser {
  readonly id: string
  readonly email: string
  readonly emailVerified: boolean
}

/**
 * The typed client derived from the `AuthApi` contract. Built once and reused.
 * `baseUrl` points at the Start server route (`/api/*`), whose splat handler
 * strips the `/api` prefix before routing to the Effect `HttpApi` — the same
 * arrangement as the jobs client. The session cookie is HttpOnly and set by
 * the API; the browser sends it back automatically on same-origin requests.
 */
const clientPromise = Effect.runPromise(
  HttpApiClient.make(AuthApi, {
    baseUrl: typeof window !== "undefined" ? window.location.origin + "/api" : "http://localhost:3000/api"
  }).pipe(Effect.provide(FetchHttpClient.layer))
)

export const requestEmailCode = async (email: string): Promise<{ signInSessionId: string; email: string }> => {
  const client = await clientPromise
  return Effect.runPromise(client.auth.emailCode({ payload: { email } }))
}

export const verifyEmailCode = async (signInSessionId: string, code: string): Promise<AuthUser> => {
  const client = await clientPromise
  const result = await Effect.runPromise(client.auth.emailCodeVerify({ payload: { signInSessionId, code } }))
  return result.user
}

export const startOAuth = async (provider: string): Promise<{ authorizationUrl: string; state: string }> => {
  const client = await clientPromise
  return Effect.runPromise(client.auth.oauthStart({ params: { provider } }))
}

export const fetchMe = async (): Promise<AuthUser | null> => {
  const client = await clientPromise
  try {
    return await Effect.runPromise(client.auth.me({}))
  } catch {
    return null
  }
}

export const signOut = async (): Promise<void> => {
  const client = await clientPromise
  await Effect.runPromise(client.auth.signout({}))
}