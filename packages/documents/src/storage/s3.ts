import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { Config, Effect, Layer, Redacted } from "effect"
import { Storage, StorageFailure } from "./storage.js"

const storageFailure =
  (message: string) =>
  (cause: unknown): StorageFailure =>
    new StorageFailure({ reason: message + (cause instanceof Error ? `: ${cause.message}` : "") })

const isNotFound = (cause: unknown): boolean => {
  if (cause === null || typeof cause !== "object" || !("name" in cause)) return false
  const name = (cause as { name: unknown }).name
  return name === "NotFound" || name === "NoSuchKey" || name === "NoSuchBucket"
}

/**
 * The live storage layer, backed by any S3-compatible endpoint. `endpoint`,
 * `region`, bucket, and credentials come from the environment; `forcePathStyle`
 * must be true for Garage and most non-AWS S3 implementations.
 */
export const S3StorageLive: Layer.Layer<Storage, Config.ConfigError, never> = Layer.effect(
  Storage,
  Effect.gen(function*() {
    const bucket = yield* Config.string("STORAGE_BUCKET")
    const endpoint = yield* Config.string("STORAGE_ENDPOINT")
    const region = yield* Config.string("STORAGE_REGION").pipe(Config.withDefault("us-east-1"))
    const accessKeyId = yield* Config.redacted("STORAGE_ACCESS_KEY_ID")
    const secretAccessKey = yield* Config.redacted("STORAGE_SECRET_ACCESS_KEY")
    const forcePathStyle = yield* Config.boolean("STORAGE_FORCE_PATH_STYLE").pipe(Config.withDefault(true))

    const client = new S3Client({
      endpoint,
      region,
      forcePathStyle,
      // Disable the SDK's default "flexible checksums" for this client, which
      // otherwise signs an empty-body CRC32 into presigned PUT URLs. Garage
      // validates that checksum against the actual uploaded bytes and rejects
      // any real body with `InvalidDigest`.
      requestChecksumCalculation: "WHEN_REQUIRED",
      credentials: {
        accessKeyId: Redacted.value(accessKeyId),
        secretAccessKey: Redacted.value(secretAccessKey)
      }
    })

    return Storage.of({
      presignPut: (key, contentType, sizeBytes) =>
        Effect.tryPromise({
          try: () =>
            getSignedUrl(
              client,
              new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                ContentType: contentType,
                ContentLength: sizeBytes
              }),
              { expiresIn: 3600 }
            ),
          catch: (error) => error as Error
        }).pipe(Effect.mapError(storageFailure("failed to presign PUT"))).pipe(
          Effect.andThen((url) => Effect.succeed({ url }))
        ),
      presignGet: (key) =>
        Effect.tryPromise({
          try: () => getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 3600 }),
          catch: (error) => error as Error
        }).pipe(Effect.mapError(storageFailure("failed to presign GET"))).pipe(
          Effect.andThen((url) => Effect.succeed({ url }))
        ),
      headObject: (key) =>
        Effect.tryPromise({
          try: () => client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
          catch: (error) => error as Error
        }).pipe(
          Effect.andThen((head) =>
            Effect.succeed({
              size_bytes: head.ContentLength ?? 0,
              content_type: head.ContentType ?? "application/octet-stream"
            })
          ),
          Effect.catch((cause: unknown) => {
            if (isNotFound(cause)) return Effect.succeed(null)
            return Effect.fail(storageFailure("failed to head object")(cause))
          })
        ),
      deleteObject: (key) =>
        Effect.tryPromise({
          try: () => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })),
          catch: (error) => error as Error
        }).pipe(
          Effect.mapError(storageFailure("failed to delete object")),
          Effect.as(void 0)
        )
    })
  })
)