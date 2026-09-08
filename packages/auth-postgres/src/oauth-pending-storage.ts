import { OAuthPendingStore } from "@app/auth/httpapi"
import type { OAuthPending } from "@app/auth/httpapi"
import { Effect, Layer, Option } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
import type { OAuthPendingRow } from "./models.ts"

/** How long an in-flight OAuth authorization may await its callback. */
const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000

const toPending = (row: OAuthPendingRow): OAuthPending => ({
  state: row.state,
  provider: row.provider,
  verifier: row.verifier,
  ...(row.nonce !== null ? { nonce: row.nonce } : {})
})

/**
 * The Postgres implementation of `OAuthPendingStore` over a bound `SqlClient`.
 * Shares the auth schema with `AuthStoragePostgres`, so a pending record set by
 * one instance (or serverless function) is visible to the callback on any other.
 * Rows carry a `created_at` and are treated as expired past the TTL, mirroring
 * the short life of an OAuth authorization code. Storage-layer failures are
 * defects (`Effect.orDie`), matching the seam contract.
 */
export const OAuthPendingStorePostgres: Effect.Effect<
  OAuthPendingStore["Service"],
  never,
  SqlClient.SqlClient
> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return OAuthPendingStore.of({
    set: (state, pending) =>
      Effect.gen(function*(): Effect.gen.Return<void, SqlError.SqlError, never> {
        yield* sql`DELETE FROM auth.oauth_pending WHERE created_at < now() - make_interval(secs => ${OAUTH_PENDING_TTL_MS / 1000})`
        yield* sql`
          INSERT INTO auth.oauth_pending (state, provider, verifier, nonce)
          VALUES (${state}, ${pending.provider}, ${pending.verifier}, ${pending.nonce ?? null})
          ON CONFLICT (state) DO UPDATE SET
            provider = EXCLUDED.provider,
            verifier = EXCLUDED.verifier,
            nonce = EXCLUDED.nonce,
            created_at = now()
        `
      }).pipe(Effect.orDie),
    get: (state) =>
      Effect.gen(function*(): Effect.gen.Return<Option.Option<OAuthPending>, SqlError.SqlError, never> {
        const rows = yield* sql<OAuthPendingRow>`
          SELECT state, provider, verifier, nonce, created_at
          FROM auth.oauth_pending
          WHERE state = ${state}
            AND created_at >= now() - make_interval(secs => ${OAUTH_PENDING_TTL_MS / 1000})
          LIMIT 1
        `
        return rows.length === 0 ? Option.none() : Option.some(toPending(rows[0]))
      }).pipe(Effect.orDie),
    delete: (state) =>
      Effect.gen(function*(): Effect.gen.Return<void, SqlError.SqlError, never> {
        yield* sql`DELETE FROM auth.oauth_pending WHERE state = ${state}`
      }).pipe(Effect.orDie)
  })
})

/** Layer form of `OAuthPendingStorePostgres`, ready to be provided a `SqlClient`. */
export const OAuthPendingStorePostgresLayer: Layer.Layer<OAuthPendingStore, never, SqlClient.SqlClient> =
  Layer.effect(OAuthPendingStore, OAuthPendingStorePostgres)