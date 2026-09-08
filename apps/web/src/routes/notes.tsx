import { useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createNoteRequest, deleteNoteRequest, fetchNotes } from "../api/notes"
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"

export const Route = createFileRoute("/notes")({
  component: NotesPage
})

function NotesPage() {
  const queryClient = useQueryClient()
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")

  const { data, isPending, isError } = useQuery({
    queryKey: ["notes"],
    queryFn: fetchNotes
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["notes"] })

  const create = (event: React.FormEvent) => {
    event.preventDefault()
    createNoteRequest({ title, body })
      .then(() => {
        setTitle("")
        setBody("")
        invalidate()
      })
      .catch(() => {})
  }

  const remove = (id: string) => {
    deleteNoteRequest(id).then(invalidate).catch(() => {})
  }

  return (
    <div>
      <header>
        <h1 className="text-2xl font-bold">My notes</h1>
        <p>
          <Link to="/">← Home</Link>
        </p>
      </header>

      <form onSubmit={create}>
        <input
          type="text"
          placeholder="Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
        />
        <input
          type="text"
          placeholder="Body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        <Button type="submit">Add note</Button>
      </form>

      {isPending && <p>Loading notes…</p>}
      {isError && <p>Failed to load notes.</p>}

      {data && (
        <Table>
          <TableHeader>
            <TableRow>
              <th>Title</th>
              <th>Body</th>
              <th>Created</th>
              <th></th>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((note) => (
              <TableRow key={note.id}>
                <TableCell>{note.title}</TableCell>
                <TableCell>{note.body}</TableCell>
                <TableCell>{new Date(note.created_at).toLocaleString()}</TableCell>
                <TableCell>
                  <Button onClick={() => remove(note.id)}>Delete</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}