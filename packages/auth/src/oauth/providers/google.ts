import type { IdTokenClaims } from "../../jwt.ts"
import type { OidcProvider } from "../protocol.ts"
import type { ProviderIdentity } from "./identity.ts"

/** Google's OpenID configuration endpoint. */
export const GOOGLE_DISCOVERY_URL = "https://accounts.google.com/.well-known/openid-configuration"
/** Stable OIDC issuer Google's discovery document advertises. */
export const GOOGLE_ISSUER = "https://accounts.google.com"
export const GOOGLE_SCOPES = ["openid", "email", "profile"] as const
/** The signing algorithms Google's discovery document advertises. */
export const GOOGLE_ALGORITHMS = ["RS256", "ES256"] as const

export interface GoogleConfig {
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
}

export const googleProvider = (config: GoogleConfig): OidcProvider => ({
  kind: "oidc",
  clientId: config.clientId,
  clientSecret: config.clientSecret,
  scopes: [...GOOGLE_SCOPES],
  redirectUri: config.redirectUri,
  discoveryUrl: GOOGLE_DISCOVERY_URL,
  algorithms: [...GOOGLE_ALGORITHMS],
  fetchUserInfo: true
})

/**
 * Maps the verified `id_token` claims to the canonical identity shape. `sub`
 * is the stable account-linking key; `email` + `email_verified` feed the user
 * record and its email-verified flag (ticket 09 consumes these). Google always
 * provides `sub`, and `email`/`email_verified` when the `email` scope is
 * granted — absent claims resolve to `null`/`false` rather than failing.
 */
export const googleIdentity = (claims: IdTokenClaims): ProviderIdentity => ({
  provider: "google",
  providerAccountId: claims.sub,
  email: claims.email ?? null,
  emailVerified: claims.email_verified === true,
  name: claims.name ?? null,
  picture: claims.picture ?? null
})