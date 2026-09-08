import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { Headers, HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Mailer } from "@app/auth"
import { ResendMailerLayer } from "./resend.ts"

const RESEND_API_URL = "https://api.resend.com/emails"

const readBody = (request: { body: unknown }): string => {
  if (request.body instanceof HttpBody.Uint8Array) {
    return new TextDecoder().decode(request.body.body)
  }
  if (request.body instanceof HttpBody.Json) {
    return JSON.stringify(request.body.body)
  }
  return ""
}

const makeFakeResend = () => {
  let last: { url: string; authorization: string; body: unknown } | null = null
  const client = HttpClient.make((request) => {
    const url = new URL(request.url)
    const authorization = Option.getOrElse(Headers.get(request.headers, "authorization"), () => "")
    last = { url: url.toString(), authorization, body: null }
    return Effect.gen(function*() {
      const body = readBody(request)
      last = { url: url.toString(), authorization, body: body === "" ? null : JSON.parse(body) }
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ id: "resend-123" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    })
  })
  return { client, lastRequest: () => last }
}

const makeTestLayer = () => {
  const fake = makeFakeResend()
  const TestLayer: Layer.Layer<Mailer, never, never> = ResendMailerLayer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, fake.client))
  )
  return { fake, TestLayer }
}

describe("ResendMailer", () => {
  it("sends the code to the Resend API with the API key and message body", async () => {
    const previous = process.env.RESEND_API_KEY
    process.env.RESEND_API_KEY = "re_123"
    const { fake, TestLayer } = makeTestLayer()
    try {
      const program = Effect.gen(function*() {
        const mailer = yield* Mailer
        yield* mailer.sendEmailCode("alice@example.com", "ABCDEFGH")
      })
      await Effect.runPromise(Effect.provide(program, TestLayer))
      const req = fake.lastRequest()
      expect(req).not.toBeNull()
      expect(req?.url).toBe(RESEND_API_URL)
      expect(req?.authorization).toBe("Bearer re_123")
      expect(req?.body).toEqual({
        from: "JobDetective <no-reply@app.dev>",
        to: ["alice@example.com"],
        subject: "Your JobDetective sign-in code",
        text: "Your JobDetective sign-in code is ABCDEFGH."
      })
    } finally {
      if (previous === undefined) delete process.env.RESEND_API_KEY
      else process.env.RESEND_API_KEY = previous
    }
  })
})