import { Machine } from "@typeonce/effect-machine"
import { Context, Effect, Schema, Stream } from "effect"
import { Queue } from "effect"

/**
 * The upload flow as a state machine. Each machine instance owns one file
 * upload. The `File` is the machine input (decoded once, then only its
 * serializable metadata is seeded onto the root — a `File` cannot be a state
 * field). The API is a `Context.Service` supplied by the application runtime;
 * its live implementation closes over the file, so the machine module stays
 * free of React/HTTP and remains fully drivable through the `MachineTest`
 * harness.
 *
 *   Input → Creating (createDocument → presigned PUT url)
 *         → Uploading (stream PUT, progress via raised `Progress` events)
 *         → Confirming (confirmDocument, server HEAD-verifies)
 *         → Done | Failed (Retry re-enters the failed phase)
 */

export class UploadApiError extends Schema.TaggedError<UploadApiError>()("UploadApiError", {
  message: Schema.String
}) {}

export class UploadApi extends Context.Service<UploadApi, {
  /** Create a pending document and return its id + a presigned PUT URL. */
  readonly createDocument: (input: {
    readonly filename: string
    readonly content_type: string
    readonly size_bytes: number
  }) => Effect.Effect<{ readonly id: string; readonly uploadUrl: string }, UploadApiError>
  /**
   * PUT the bytes directly to the presigned URL. `onProgress(percent)` is
   * called with 0–100 as the request proceeds.
   */
  readonly putObject: (
    uploadUrl: string,
    content_type: string,
    onProgress: (percent: number) => void
  ) => Effect.Effect<void, UploadApiError>
  /** Confirm a stored document (server HEAD-verifies the object). */
  readonly confirmDocument: (id: string) => Effect.Effect<void, UploadApiError>
  /** Fetch a fresh presigned PUT url for an existing pending document (retry). */
  readonly resumeDocument: (id: string) => Effect.Effect<{ readonly uploadUrl: string }, UploadApiError>
}>()("app/web/UploadApi") {}

const Root = Machine.state({
  initial: "Creating",
  fields: {
    filename: Schema.String,
    content_type: Schema.String,
    size_bytes: Schema.Number
  },
  states: {
    Idle: {},
    Creating: {},
    Uploading: {
      fields: {
        documentId: Schema.String,
        uploadUrl: Schema.String,
        progress: Schema.Number
      }
    },
    Resuming: {
      fields: {
        documentId: Schema.String
      }
    },
    Confirming: {
      fields: {
        documentId: Schema.String
      }
    },
    Done: {
      fields: {
        documentId: Schema.String
      }
    },
    Cancelled: {},
    CreateFailed: {
      fields: {
        message: Schema.String
      }
    },
    UploadFailed: {
      fields: {
        documentId: Schema.String,
        message: Schema.String
      }
    },
    ConfirmFailed: {
      fields: {
        documentId: Schema.String,
        message: Schema.String
      }
    }
  }
})

export const UploadEvents = Machine.events({
  Retry: {},
  Cancel: {}
})

class Progress extends Schema.TaggedClass<Progress>("Progress")("Progress", {
  percent: Schema.Number
}) {}

const InternalEvents = Machine.internalEventsFromSchemas(Progress)

/**
 * A progress stream of the direct PUT, wrapped around the API's XHR. The API
 * requirement surfaces on the invoke so the runtime must provide `UploadApi`.
 */
const putObjectStream = (uploadUrl: string, contentType: string): Stream.Stream<number, UploadApiError, UploadApi> =>
  Stream.service(UploadApi).pipe(
    Stream.flatMap((api) =>
      Stream.callback<number, UploadApiError>((queue) =>
        api.putObject(uploadUrl, contentType, (percent) => {
          Effect.runFork(Queue.offer(queue, percent))
        }).pipe(
          Effect.andThen(() => Queue.end(queue)),
          Effect.catch((error: UploadApiError) => Queue.fail(queue, error))
        )
      )
    )
  )

const machine = Machine.make({
  id: "UploadMachine",
  root: Root,
  events: UploadEvents,
  internalEvents: InternalEvents,
  input: Schema.File,
  initial: (root) =>
    root.from(({ input }) => ({
      filename: input.name,
      content_type: input.type || "application/octet-stream",
      size_bytes: input.size
    }))
})

export const UploadMachine = machine.handle({
  states: {
    Idle: {},
    Creating: {
      invoke: (from) =>
        from
          .effect("create", ({ containingState }) =>
            Effect.gen(function*() {
              const api = yield* UploadApi
              return yield* api.createDocument({
                filename: containingState.filename,
                content_type: containingState.content_type,
                size_bytes: containingState.size_bytes
              })
            })
          )
          .onDone((to) =>
            to.branch.Uploading().resolve(({ output, target }) =>
              target.from({ documentId: output.id, uploadUrl: output.uploadUrl, progress: 0 })
            )
          )
          .onFailure((to) =>
            to.branch.CreateFailed().resolve(({ error, target }) => target.from({ message: error.message }))
          )
    },
    Uploading: {
      invoke: (from) =>
        from
          .stream("upload-progress", ({ state, containingState }) =>
            putObjectStream(state.uploadUrl, containingState.content_type)
          )
          .onElement((to) =>
            to.none.resolve(({ element }, enqueue) => {
              enqueue.raise(new Progress({ percent: element }))
            })
          )
          .onDone((to) =>
            to.branch.Confirming().resolve(({ state, target }) =>
              target.from({ documentId: state.documentId })
            )
          )
          .onFailure((to) =>
            to.branch.UploadFailed().resolve(({ state, error, target }) =>
              target.from({ documentId: state.documentId, message: error.message })
            )
          ),
      on: {
        Progress: (to) =>
          to.branch.Uploading().resolve(({ event, state, target }) =>
            target.from({ documentId: state.documentId, uploadUrl: state.uploadUrl, progress: event.percent })
          ),
        Cancel: (to) => to.branch.Cancelled()
      }
    },
    Resuming: {
      invoke: (from) =>
        from
          .effect("resume", ({ state }) =>
            Effect.gen(function*() {
              const api = yield* UploadApi
              return yield* api.resumeDocument(state.documentId)
            })
          )
          .onDone((to) =>
            to.branch.Uploading().resolve(({ state, output, target }) =>
              target.from({ documentId: state.documentId, uploadUrl: output.uploadUrl, progress: 0 })
            )
          )
          .onFailure((to) =>
            to.branch.UploadFailed().resolve(({ state, error, target }) =>
              target.from({ documentId: state.documentId, message: error.message })
            )
          )
    },
    Confirming: {
      invoke: (from) =>
        from
          .effect("confirm", ({ state }) =>
            Effect.gen(function*() {
              const api = yield* UploadApi
              return yield* api.confirmDocument(state.documentId)
            })
          )
          .onDone((to) =>
            to.branch.Done().resolve(({ state, target }) => target.from({ documentId: state.documentId }))
          )
          .onFailure((to) =>
            to.branch.ConfirmFailed().resolve(({ state, error, target }) =>
              target.from({ documentId: state.documentId, message: error.message })
            )
          )
    },
    Done: {},
    CreateFailed: {
      on: {
        Retry: (to) => to.branch.Creating()
      }
    },
    UploadFailed: {
      on: {
        Retry: (to) =>
          to.branch.Resuming().resolve(({ state, target }) => target.from({ documentId: state.documentId }))
      }
    },
    ConfirmFailed: {
      on: {
        Retry: (to) =>
          to.branch.Confirming().resolve(({ state, target }) => target.from({ documentId: state.documentId }))
      }
    }
  }
})