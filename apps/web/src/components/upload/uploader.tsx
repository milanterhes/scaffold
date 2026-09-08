import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { createMachineContext, MachineState } from "@typeonce/effect-machine-react"
import { useAtomSuspense, useAtomSet } from "@effect/atom-react"
import { Atom } from "effect/unstable/reactivity"
import { useEffect, useRef, useState } from "react"
import { UploadMachine, UploadEvents, type UploadApi } from "../../lib/upload/upload.machine"
import { UploadApiLive } from "../../lib/upload/upload.api"
import { Button } from "@/components/ui/button"

/**
 * One file upload, modeled as an effect-machine atom. Each selected file gets
 * a fresh machine via the React `key`, with a fresh `UploadApi` runtime that
 * captures that file's bytes. The machine reads the `File` from its input;
 * state carries only serializable metadata.
 */
const Upload = createMachineContext(
  (file: File) =>
    AtomMachine.bind<UploadApi, never>(Atom.runtime(UploadApiLive(file))).factory(UploadMachine)(file)
)

/** The atom type of an owned upload machine. */
type UploadMachineAtom = ReturnType<typeof Upload.useMachine>

export function Uploader({ onStored }: { readonly onStored?: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  if (file === null) {
    return (
      <>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <Button type="button" onClick={() => inputRef.current?.click()}>
          Choose a file to upload
        </Button>
      </>
    )
  }

  return (
    <Upload.Provider key={`${file.name}:${file.size}:${file.lastModified}`} input={file}>
      <UploadScreen onStored={onStored ?? (() => {})} onReset={() => setFile(null)} />
    </Upload.Provider>
  )
}

/** Reads the owned machine from the provider and renders it by state. */
function UploadScreen({ onStored, onReset }: { readonly onStored: () => void; readonly onReset: () => void }) {
  const machine = Upload.useMachine()
  const send = useAtomSet(machine.send)
  const retry = () => send(UploadEvents.Retry())
  const cancel = () => send(UploadEvents.Cancel())

  return (
    <>
      <MachineState machine={machine} path="Uploading" inactive={null}>
        {({ value: { progress } }) => (
          <>
            <p>Uploading… {progress}%</p>
            <Button onClick={cancel}>Cancel</Button>
          </>
        )}
      </MachineState>
      <MachineState machine={machine} path="Confirming" inactive={null}>
        {() => <p>Confirming…</p>}
      </MachineState>
      <MachineState machine={machine} path="Resuming" inactive={null}>
        {() => <p>Resuming…</p>}
      </MachineState>
      <MachineState machine={machine} path="CreateFailed" inactive={null}>
        {({ value: { message } }) => (
          <div>
            <p className="text-red-600">Create failed: {message}</p>
            <Button onClick={retry}>Retry</Button>
          </div>
        )}
      </MachineState>
      <MachineState machine={machine} path="UploadFailed" inactive={null}>
        {({ value: { message } }) => (
          <div>
            <p className="text-red-600">Upload failed: {message}</p>
            <Button onClick={retry}>Retry</Button>
          </div>
        )}
      </MachineState>
      <MachineState machine={machine} path="ConfirmFailed" inactive={null}>
        {({ value: { message } }) => (
          <div>
            <p className="text-red-600">Confirm failed: {message}</p>
            <Button onClick={retry}>Retry</Button>
          </div>
        )}
      </MachineState>
      <MachineState machine={machine} path="Done" inactive={null}>
        {() => (
          <p>
            Uploaded.{" "}
            <Button onClick={onReset}>Upload another</Button>
          </p>
        )}
      </MachineState>
      <MachineState machine={machine} path="Cancelled" inactive={null}>
        {() => (
          <p>
            Upload cancelled.{" "}
            <Button onClick={onReset}>Choose another file</Button>
          </p>
        )}
      </MachineState>
      <MachineState machine={machine} path="Idle" inactive={null}>
        {() => <p>Preparing…</p>}
      </MachineState>
      <StoredNotifier machine={machine} onStored={onStored} />
    </>
  )
}

/** Fires `onStored` (e.g. refetch the list) once the machine reaches Done. */
function StoredNotifier({ machine, onStored }: { readonly machine: UploadMachineAtom; readonly onStored: () => void }) {
  const done = useAtomSuspense(AtomMachine.matches(machine, "Done")).value
  useEffect(() => {
    if (done) onStored()
  }, [done, onStored])
  return null
}

export type { UploadApi }