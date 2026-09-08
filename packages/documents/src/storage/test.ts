import { Context, Effect, Layer } from "effect"
import { Storage } from "./storage.js"

interface StoredObject {
  readonly bytes: Uint8Array
  readonly content_type: string
}

interface StoreShape {
  readonly put: (key: string, bytes: Uint8Array, content_type: string) => Effect.Effect<void>
  readonly get: (key: string) => Effect.Effect<StoredObject | null>
  readonly delete: (key: string) => Effect.Effect<void>
  readonly size: () => Effect.Effect<number>
}

/**
 * The mutable state backing the in-memory `Storage`. Tests reach into this
 * service to simulate a client's PUT (placing bytes) and to assert on storage
 * contents. The app itself never sees it — only the `Storage` interface.
 */
export class MemoryStorageStore extends Context.Service<MemoryStorageStore, StoreShape>()(
  "app/documents/MemoryStorageStore"
) {}

/** Provides the store; the map is created once here and shared with `Storage`. */
export const MemoryStorageStoreLive: Layer.Layer<MemoryStorageStore> = Layer.effect(
  MemoryStorageStore,
  Effect.gen(function*() {
    const objects = new Map<string, StoredObject>()
    return MemoryStorageStore.of({
      put: (key, bytes, content_type) =>
        Effect.sync(() => {
          objects.set(key, { bytes, content_type })
        }),
      get: (key) => Effect.sync(() => objects.get(key) ?? null),
      delete: (key) =>
        Effect.sync(() => {
          objects.delete(key)
        }),
      size: () => Effect.sync(() => objects.size)
    })
  })
)

/**
 * An in-memory `Storage` implementation for tests, backed by the shared
 * `MemoryStorageStore`. `presignPut`/`presignGet` return local URLs a client
 * would PUT/GET; tests place and inspect bytes through the store.
 */
export const MemoryStorageLayer: Layer.Layer<Storage, never, MemoryStorageStore> = Layer.effect(
  Storage,
  Effect.gen(function*() {
    const store = yield* MemoryStorageStore

    return Storage.of({
      presignPut: (key) =>
        Effect.succeed({ url: `http://storage.test/put/${encodeURIComponent(key)}` }),
      presignGet: (key) =>
        Effect.succeed({ url: `http://storage.test/get/${encodeURIComponent(key)}` }),
      headObject: (key) =>
        Effect.gen(function*() {
          const object = yield* store.get(key)
          return object === null
            ? null
            : { size_bytes: object.bytes.byteLength, content_type: object.content_type }
        }),
      deleteObject: (key) => store.delete(key)
    })
  })
)

/** The combined in-memory storage test layer: `Storage` and its shared store. */
export const MemoryStorageTest: Layer.Layer<
  Storage | MemoryStorageStore,
  never,
  never
> = MemoryStorageLayer.pipe(Layer.provideMerge(MemoryStorageStoreLive))

/**
 * The key a `presignPut` URL refers to. Tests extract it to place bytes via the
 * store, simulating the client's direct PUT to storage.
 */
export const keyFromPresignedPutUrl = (url: string): string => {
  const match = /\/put\/(.+)$/.exec(url)
  if (match === null) throw new Error(`not a presigned PUT url: ${url}`)
  return decodeURIComponent(match[1])
}