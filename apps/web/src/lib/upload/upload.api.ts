import { Effect, Layer } from "effect"
import { UploadApi, UploadApiError } from "./upload.machine"
import { createDocumentRequest, confirmDocumentRequest, fetchDocument } from "../../api/documents"

/**
 * The browser implementation of `UploadApi`, backed by the typed documents
 * client. The `File` is captured when the machine's input is set, so the same
 * service serves one upload per owned machine (React keys a fresh instance per
 * file).
 */

/** Build a live `UploadApi` layer bound to a specific file's bytes. */
export const UploadApiLive = (file: File): Layer.Layer<UploadApi> =>
  Layer.effect(
    UploadApi,
    Effect.gen(function*() {
      return UploadApi.of({
        createDocument: (input) =>
          Effect.tryPromise(() => createDocumentRequest(input)).pipe(
            Effect.mapError(() => new UploadApiError({ message: "failed to create document" })),
            Effect.andThen(({ document, uploadUrl }) => Effect.succeed({ id: document.id, uploadUrl }))
          ),
        putObject: (uploadUrl, content_type, onProgress) =>
          Effect.callback<void, UploadApiError>((resume, signal) => {
            const xhr = new XMLHttpRequest()
            xhr.open("PUT", uploadUrl)
            xhr.setRequestHeader("content-type", content_type)
            const abort = () => xhr.abort()
            signal.addEventListener("abort", abort)
            xhr.upload.onprogress = (event) => {
              if (event.lengthComputable) {
                onProgress(Math.round((event.loaded / event.total) * 100))
              }
            }
            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) {
                onProgress(100)
                resume(Effect.succeed(void 0))
              } else {
                resume(Effect.fail(new UploadApiError({ message: `upload failed with status ${xhr.status}` })))
              }
            }
            xhr.onerror = () => {
              resume(Effect.fail(new UploadApiError({ message: "upload failed: network error" })))
            }
            xhr.send(file)
          }),
        confirmDocument: (id) =>
          Effect.tryPromise(() => confirmDocumentRequest(id)).pipe(
            Effect.mapError(() => new UploadApiError({ message: "failed to confirm document" })),
            Effect.as(void 0)
          ),
        resumeDocument: (id) =>
          Effect.tryPromise(() => fetchDocument(id)).pipe(
            Effect.mapError(() => new UploadApiError({ message: "failed to resume document" })),
            Effect.andThen((result) =>
              result.upload.kind === "upload"
                ? Effect.succeed({ uploadUrl: result.upload.url })
                : Effect.fail(new UploadApiError({ message: "document is not awaiting upload" }))
            )
          )
      })
    })
  )