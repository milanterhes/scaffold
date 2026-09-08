import { Context, Effect, Schema } from "effect"

/**
 * The storage service: an object-store seam over S3-compatible storage. The
 * app talks only to this interface — never to AWS SDK types directly — so the
 * production S3 backend and an in-memory test double are interchangeable and
 * the rest of the code never depends on a specific vendor.
 */

export class StorageFailure extends Schema.TaggedError<StorageFailure>()("StorageFailure", {
  reason: Schema.String
}, { httpApiStatus: 500 }) {}

export class StorageObjectNotFound extends Schema.TaggedError<StorageObjectNotFound>()(
  "StorageObjectNotFound",
  {
    key: Schema.String
  },
  { httpApiStatus: 404 }
) {}

export type StorageError = StorageFailure | StorageObjectNotFound

export interface StorageObject {
  readonly size_bytes: number
  readonly content_type: string
}

export interface PresignedUrl {
  readonly url: string
}

/**
 * The storage contract. The production implementation talks to S3-compatible
 * storage (AWS S3 or Garage) over the AWS SDK v3; an in-memory double lives in
 * `./test` for tests. Both satisfy this exact interface.
 */
export class Storage extends Context.Service<Storage, {
  /**
   * A short-lived URL the client PUTs the object bytes to. `contentType` and
   * `sizeBytes` are asserted by the store when the PUT is signed, so a client
   * cannot upload a mismatched object.
   */
  readonly presignPut: (
    key: string,
    contentType: string,
    sizeBytes: number
  ) => Effect.Effect<PresignedUrl, StorageError>
  /** A short-lived URL the client GETs the object bytes from. */
  readonly presignGet: (key: string) => Effect.Effect<PresignedUrl, StorageError>
  /** The stored object's actual size and content type; `null` when absent. */
  readonly headObject: (key: string) => Effect.Effect<StorageObject | null, StorageError>
  /** Delete an object; a successful no-op when it does not exist. */
  readonly deleteObject: (key: string) => Effect.Effect<void, StorageError>
}>()("app/documents/Storage") {}