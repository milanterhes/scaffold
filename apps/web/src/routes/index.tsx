import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { fetchMe, signOut } from "../api/auth"
import { Button } from "@/components/ui/button"

export const Route = createFileRoute("/")({
  component: HomePage
})

function AuthBadge() {
  const queryClient = useQueryClient()
  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: fetchMe
  })

  if (me === null || me === undefined) {
    return (
      <p>
        <Link to="/signin">Sign in</Link>
      </p>
    )
  }

  return (
    <p>
      <span>{me.email}</span>{" "}
      <Link to="/notes">My notes</Link>{" "}
      <Link to="/documents">Documents</Link>{" "}
      <Button
        onClick={() => {
          signOut().then(() => queryClient.invalidateQueries({ queryKey: ["me"] }))
        }}
      >
        Sign out
      </Button>
    </p>
  )
}

function HomePage() {
  return (
    <div>
      <header>
        <h1 className="text-2xl font-bold">Scaffold</h1>
        <p className="text-sm text-gray-500">
          A starter monorepo: TanStack Start + Effect HttpApi + a session-based
          auth package.
        </p>
        <AuthBadge />
      </header>

      <section>
        <h2>What's here</h2>
        <ul>
          <li>
            <strong>Auth</strong> — email-code sign-in plus optional Google,
            LinkedIn, GitHub OAuth; sessions with sliding expiry; account
            linking and a privacy/delete-me endpoint. No Resend key needed
            locally: codes print to the server terminal.
          </li>
          <li>
            <strong>Notes</strong> — a small user-scoped CRUD group showing how
            to add your own <code>HttpApi</code> endpoints, Postgres repo, and
            React page.
          </li>
        </ul>
      </section>
    </div>
  )
}