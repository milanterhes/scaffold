import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { S3StorageLive } from "./s3.js"
import { Storage } from "./storage.js"

/**
 * A round-trip test against a real S3-compatible endpoint (Garage locally).
 * Skipped when the `STORAGE_*` env vars are absent, so the suite passes on a
 * machine without object storage configured. The pre-agreed storage seam runs
 * against Garage via `docker compose up -d garage` plus the `.env` vars.
 */
const s3LayerAvailable = (): boolean => process.env.STORAGE_ENDPOINT !== undefined && process.env.STORAGE_ENDPOINT !== ""

describe.skipIf(!s3LayerAvailable())("S3StorageLive against a real endpoint", () => {
  const TestLayer = S3StorageLive as Layer.Layer<Storage, never, never>

  it.effect("presigns a PUT, uploads raw bytes, heads them, presigns a GET, deletes", () =>
    Effect.gen(function*() {
      const storage = yield* Storage
      const key = `test/${Date.now()}-${Math.random()}`

      const putUrl = yield* storage.presignPut(key, "text/plain", 11)
      const response = yield* Effect.tryPromise(() =>
        fetch(putUrl.url, {
          method: "PUT",
          headers: { "content-type": "text/plain" },
          body: new TextEncoder().encode("hello world")
        })
      )
      expect(response.status).toBe(200)

      const head = yield* storage.headObject(key)
      expect(head).not.toBeNull()
      expect(head?.size_bytes).toBe(11)
      expect(head?.content_type).toBe("text/plain")

      const getUrl = yield* storage.presignGet(key)
      const fetched = yield* Effect.tryPromise(() => fetch(getUrl.url))
      const body = yield* Effect.tryPromise(() => fetched.text())
      expect(body).toBe("hello world")

      yield* storage.deleteObject(key)
      const gone = yield* storage.headObject(key)
      expect(gone).toBeNull()
    }).pipe(Effect.provide(TestLayer)))
})