import { Context, Effect, Layer } from "effect"

/**
 * The email seam. `@app/auth` sends sign-in codes through this
 * interface; the implementor owns the delivery. This package ships a
 * `LoggerMailerLayer` that prints codes to the terminal for local development
 * and a `MemoryMailer` for test assertions; live implementations (e.g. Resend)
 * live in their own packages.
 */
export class Mailer extends Context.Service<Mailer, {
  readonly sendEmailCode: (to: string, code: string) => Effect.Effect<void>
}>()("app/auth/Mailer") {}

export type MailerService = Mailer["Service"]

/**
 * A mailer that records sent messages for test assertions, installed alongside
 * the `Mailer` service it implements. `sent` returns everything sent so far;
 * `clear` empties the log.
 */
export class MemoryMailer extends Context.Service<MemoryMailer, {
  readonly sent: Effect.Effect<ReadonlyArray<{ to: string; code: string }>>
  readonly clear: Effect.Effect<void>
}>()("app/auth/MemoryMailer") {}

/**
 * Install both `Mailer` and `MemoryMailer` over one shared in-memory log.
 * Tests use this to assert on what would have been sent.
 */
export const MemoryMailerLayer: Layer.Layer<Mailer | MemoryMailer> = Layer.effectContext(
  Effect.gen(function*() {
    const messages: Array<{ to: string; code: string }> = []
    const sendEmailCode = (to: string, code: string) =>
      Effect.sync(() => {
        messages.push({ to, code })
      })
    const mailer = Mailer.of({ sendEmailCode })
    const memory = MemoryMailer.of({
      sent: Effect.sync(() => messages),
      clear: Effect.sync(() => {
        messages.length = 0
      })
    })
    return Context.make(Mailer, mailer).pipe(Context.add(MemoryMailer, memory))
  })
)

/**
 * A development `Mailer` that prints each code to the terminal so a developer
 * can copy it into the sign-in form. Also records into `MemoryMailer`, keeping
 * the code readable through the same service tests use.
 */
export const LoggerMailerLayer: Layer.Layer<Mailer | MemoryMailer> = Layer.effectContext(
  Effect.gen(function*() {
    const messages: Array<{ to: string; code: string }> = []
    const sendEmailCode = (to: string, code: string) =>
      Effect.sync(() => {
        console.log(`[scaffold:auth] sign-in code for ${to}: ${code}`)
        messages.push({ to, code })
      })
    const mailer = Mailer.of({ sendEmailCode })
    const memory = MemoryMailer.of({
      sent: Effect.sync(() => messages),
      clear: Effect.sync(() => {
        messages.length = 0
      })
    })
    return Context.make(Mailer, mailer).pipe(Context.add(MemoryMailer, memory))
  })
)