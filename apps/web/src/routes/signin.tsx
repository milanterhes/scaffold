import { useState } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import {
  requestEmailCode,
  startOAuth,
  verifyEmailCode
} from "../api/auth"

export const Route = createFileRoute("/signin")({
  component: SignInPage
})

const PROVIDERS = ["google", "linkedin", "github"] as const

function SignInPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState("")
  const [signInSessionId, setSignInSessionId] = useState<string | null>(null)
  const [code, setCode] = useState("")
  const [notice, setNotice] = useState<string | null>(null)

  return (
    <div>
      <header>
        <h1>Scaffold</h1>
        <p>
          <Link to="/">Back to home</Link> · Sign in
        </p>
      </header>

      <section>
        <h2>Email code</h2>
        {signInSessionId === null ? (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              requestEmailCode(email)
                .then((result) => {
                  setNotice(`Code sent to ${result.email} (dev mailer).`)
                  setSignInSessionId(result.signInSessionId)
                })
                .catch(() => setNotice("Could not send a code. Try again."))
            }}
          >
            <input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            <button type="submit">Send code</button>
          </form>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              verifyEmailCode(signInSessionId, code)
                .then(() => navigate({ to: "/" }))
                .catch(() => setNotice("That code did not work. Request a new one."))
            }}
          >
            <p>
              Enter the code sent to {email}. Without a Resend key the code is
              printed to the server terminal.
            </p>
            <input
              type="text"
              placeholder="ABCDEFGH"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
            />
            <button type="submit">Sign in</button>
          </form>
        )}
      </section>

      <section>
        <h2>OAuth</h2>
        <p>Provider buttons need matching client IDs and a redirect URI in `.env`.</p>
        {PROVIDERS.map((provider) => (
          <button
            key={provider}
            onClick={() => {
              startOAuth(provider)
                .then(({ authorizationUrl }) => {
                  window.location.href = authorizationUrl
                })
                .catch(() =>
                  setNotice(`${provider} is not configured in this environment.`)
                )
            }}
          >
            Continue with {provider}
          </button>
        ))}
      </section>

      {notice !== null && <p>{notice}</p>}
    </div>
  )
}