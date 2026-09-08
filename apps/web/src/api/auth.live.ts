import { NodeCrypto, NodeHttpClient } from "@effect/platform-node"
import {
  HasherLive,
  IdTokenVerifierLive,
  LoggerMailerLayer,
  MemoryStorageLayer,
  TokenBucketLive
} from "@app/auth"
import {
  AuthImpl,
  OAuthPendingStoreLive as MemoryOAuthPendingStoreLayer,
  OAuthProviderRegistryLive,
  SessionMiddlewareLive
} from "@app/auth/httpapi"
import { ResendMailerLayer } from "@app/auth-resend"
import {
  AuthStoragePostgresLayer,
  OAuthPendingStorePostgresLayer
} from "@app/auth-postgres"
import { PgLive } from "@app/core"
import { Layer } from "effect"

/**
 * The `AuthStorage` seam for the web runtime. Uses the Postgres `AuthStorage`
 * when the app's `DATABASE_URL` is configured, and degrades to the in-memory
 * implementation when it is not — mirroring the `liveOrUnavailable` pattern the
 * search backends use, so email-code sign-in works locally with no new secrets
 * (and no auth tables).
 */
export const AuthStorageLive = AuthStoragePostgresLayer.pipe(
  Layer.provide(PgLive),
  Layer.catchCause(() => MemoryStorageLayer)
)

/**
 * The `Mailer` seam for the web runtime. Uses Resend when `RESEND_API_KEY` is
 * configured; otherwise falls back to the logger mailer so local sign-in works
 * without email infrastructure — codes print to the server terminal.
 */
export const MailerLive = ResendMailerLayer.pipe(
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.catchCause(() => LoggerMailerLayer)
)

/**
 * The `OAuthPendingStore` seam for the web runtime. Postgres-backed so an OAuth
 * `state` set by one instance (or serverless function) is seen by the callback
 * on any other; degrades to the in-memory store when the DB is unavailable.
 */
export const OAuthPendingStoreLive = OAuthPendingStorePostgresLayer.pipe(
  Layer.provide(PgLive),
  Layer.catchCause(() => MemoryOAuthPendingStoreLayer)
)

/**
 * Every service the auth group's handlers need, in one layer: the group
 * implementation plus all seams (storage, mailer, hasher, token bucket, OAuth
 * registry/pending store, ID-token verifier, Node crypto, and an HTTP client
 * for OAuth token exchange). The session middleware is provided from the seams
 * it depends on, following the composition in `packages/auth`'s own tests.
 */
export const AuthLive = Layer.mergeAll(
  AuthImpl,
  OAuthPendingStoreLive,
  OAuthProviderRegistryLive
).pipe(
  Layer.provide(SessionMiddlewareLive),
  Layer.provideMerge(AuthStorageLive),
  Layer.provideMerge(MailerLive),
  Layer.provideMerge(HasherLive),
  Layer.provideMerge(TokenBucketLive),
  Layer.provideMerge(IdTokenVerifierLive),
  Layer.provideMerge(NodeCrypto.layer)
)