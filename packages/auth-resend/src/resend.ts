import { Config, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { EmailCodeTemplate, Mailer } from "@app/auth"

const RESEND_API_URL = "https://api.resend.com/emails"

class MailerError extends Schema.TaggedError<MailerError>()("MailerError", {
  message: Schema.String
}) {}

/**
 * The `Mailer` implementation backed by Resend's REST API. Stateless: one
 * HTTP call per code, no local state, so it stays testable through an injected
 * `HttpClient`. Reads `RESEND_API_KEY` (required) from the environment; the
 * email copy (from, subject, body) comes from `EmailCodeTemplate`, so apps
 * brand the message without editing this package.
 *
 * The layer fails with `ConfigError` when the API key is absent — an app
 * catches that and falls back to a development mailer.
 */
export const ResendMailerLayer: Layer.Layer<Mailer, Config.ConfigError, HttpClient.HttpClient | EmailCodeTemplate> = Layer.effect(
  Mailer,
  Effect.gen(function*() {
    const http = yield* HttpClient.HttpClient
    const apiKey = yield* Config.redacted("RESEND_API_KEY")
    const template = yield* EmailCodeTemplate

    const sendEmailCode = (to: string, code: string) =>
      Effect.gen(function*() {
        const request = HttpClientRequest.post(RESEND_API_URL).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(apiKey)}`),
          HttpClientRequest.bodyJsonUnsafe({
            from: template.from,
            to: [to],
            subject: template.subject,
            text: template.text(code)
          })
        )
        const response = yield* http.execute(request).pipe(
          Effect.mapError((cause) => new MailerError({ message: `resend request failed: ${cause}` }))
        )
        if (response.status < 200 || response.status >= 300) {
          return yield* new MailerError({ message: `resend HTTP ${response.status}` })
        }
        yield* HttpClientResponse.schemaBodyJson(Schema.Unknown)(response).pipe(
          Effect.mapError((cause) => new MailerError({ message: `resend body read failed: ${cause}` }))
        )
      }).pipe(Effect.orDie)

    return Mailer.of({ sendEmailCode })
  })
)