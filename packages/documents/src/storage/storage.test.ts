import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { keyFromPresignedPutUrl, MemoryStorageStore, MemoryStorageTest } from "./test.js"
import { Storage } from "./storage.js"

it.effect("round-trips an object: presign PUT, store bytes, head, presign GET, delete", () =>
  Effect.gen(function*() {
    const storage = yield* Storage
    const store = yield* MemoryStorageStore

    const putUrl = yield* storage.presignPut("user/abc/file.txt", "text/plain", 5)
    const key = keyFromPresignedPutUrl(putUrl.url)
    expect(key).toBe("user/abc/file.txt")

    yield* store.put(key, new TextEncoder().encode("hello"), "text/plain")

    const head = yield* storage.headObject(key)
    expect(head).not.toBeNull()
    expect(head?.size_bytes).toBe(5)
    expect(head?.content_type).toBe("text/plain")

    const getUrl = yield* storage.presignGet(key)
    expect(getUrl.url).toContain(`/get/${encodeURIComponent(key)}`)

    yield* storage.deleteObject(key)
    const gone = yield* storage.headObject(key)
    expect(gone).toBeNull()
  }).pipe(Effect.provide(MemoryStorageTest)))

it.effect("headObject returns null for a missing key; delete is idempotent", () =>
  Effect.gen(function*() {
    const storage = yield* Storage
    const missing = yield* storage.headObject("user/abc/nope.txt")
    expect(missing).toBeNull()
    yield* storage.deleteObject("user/abc/nope.txt")
  }).pipe(Effect.provide(MemoryStorageTest)))