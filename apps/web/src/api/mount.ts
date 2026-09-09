import { NodeHttpClient } from "@effect/platform-node"
import { PgLive } from "@app/core"
import { S3StorageLive } from "@app/documents/storage"
import { Effect, Layer, ManagedRuntime } from "effect"
import { HttpEffect, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { loadEnv } from "./env"
import { NotesImpl } from "./notes.impl"
import { DocumentsImpl } from "./documents.impl"
import { NotificationsImpl } from "./notifications.impl"
import { AuthLive } from "./auth.live"
import { SessionMiddlewareLive } from "@app/auth/httpapi"
import { WebApi } from "./web.api"

loadEnv()

/**
 * The shared server runtime: the API handlers with the Postgres client and the
 * HTTP platform services provided once at startup. Stateful services (the DB
 * pool) live here so every request shares them.
 *
 * `HttpApiBuilder.group` carries a `Request<"Requires", SqlClient>` phantom in
 * its layer requirements that `Layer.provide` does not strip at the type
 * level. The DB is provided at build time, so the phantom is satisfied at
 * runtime; cast it away so `ManagedRuntime.make` accepts the layer.
 *
 * `NodeHttpClient.layerUndici` gives the auth OAuth flow a real `HttpClient`.
 */
const ApiLive = Layer.mergeAll(NotesImpl, DocumentsImpl, NotificationsImpl, AuthLive).pipe(
  Layer.provide(PgLive),
  Layer.provide(S3StorageLive),
  Layer.provideMerge(SessionMiddlewareLive),
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.provideMerge(HttpServer.layerServices)
) as unknown as Layer.Layer<never, never, never>

export const apiRuntime = ManagedRuntime.make(ApiLive)

/**
 * The `HttpApi` router effect, built once and reused across requests. The
 * group implementations and Postgres client come from the runtime's context,
 * which also provides the scope and platform services `toHttpEffect` requires
 * (visible here only as phantom types).
 */
const buildRouter = Effect.gen(function*() {
  const handler = yield* HttpRouter.toHttpEffect(HttpApiBuilder.layer(WebApi))
  return handler
}).pipe(Effect.scoped) as Effect.Effect<
  Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, HttpServerRequest.HttpServerRequest>,
  never,
  never
>

type WebHandler = (request: globalThis.Request) => Promise<globalThis.Response>

let handlerPromise: Promise<WebHandler> | undefined

/**
 * The fetch-style handler wrapping the router, built once and reused. Built via
 * `HttpEffect.toWebHandlerWith` with the runtime's context, so per-request
 * pre-response handlers (session `Set-Cookie`) are applied and the response is
 * converted to a Web `Response` — the same bridge the package's tests use.
 */
const getHandler = (): Promise<WebHandler> => {
  handlerPromise ??= (async () => {
    const context = await apiRuntime.context()
    const router = await apiRuntime.runPromise(buildRouter)
    return HttpEffect.toWebHandlerWith(context)(
      router as unknown as Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, never>
    ) as unknown as WebHandler
  })()
  return handlerPromise
}

/**
 * Mount the Effect `HttpApi` as a fetch-style handler for a TanStack Start
 * server route, so the Effect router runs entirely inside the Start server
 * process — no separate API process.
 *
 * The Start server matches the `/api/*` splat; the Effect `HttpApi` routes on
 * its group paths (`/me/notes`, `/auth`), so the `/api` prefix is stripped from
 * the request URL before the Effect router sees it.
 */
export const apiHandler = async ({ request }: { request: globalThis.Request }): Promise<Response> => {
  const handler = await getHandler()
  const url = new URL(request.url)
  const stripped = new Request(
    `${url.origin}${url.pathname.replace(/^\/api/, "")}${url.search}`,
    request
  )
  return handler(stripped)
}