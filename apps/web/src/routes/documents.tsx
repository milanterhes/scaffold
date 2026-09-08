import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { DateTime } from "effect"
import { fetchDocument, fetchDocuments, deleteDocumentRequest } from "../api/documents"
import { Uploader } from "../components/upload/uploader"
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table"
import { Button } from "@/components/ui/button"

export const Route = createFileRoute("/documents")({
  component: DocumentsPage
})

function DocumentsPage() {
  const queryClient = useQueryClient()

  const { data, isPending, isError } = useQuery({
    queryKey: ["documents"],
    queryFn: fetchDocuments
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["documents"] })

  const download = (id: string, name: string) => {
    fetchDocument(id)
      .then(({ upload }) => {
        if (upload.kind !== "download") return
        const anchor = document.createElement("a")
        anchor.href = upload.url
        anchor.download = name
        anchor.click()
      })
      .catch(() => {})
  }

  const remove = (id: string) => {
    deleteDocumentRequest(id).then(invalidate).catch(() => {})
  }

  return (
    <div>
      <header>
        <h1 className="text-2xl font-bold">Documents</h1>
        <p>
          <Link to="/">← Home</Link>
        </p>
      </header>

      <section>
        <h2 className="text-lg font-semibold">Upload</h2>
        <Uploader onStored={invalidate} />
      </section>

      {isPending && <p>Loading documents…</p>}
      {isError && <p>Failed to load documents.</p>}

      {data && (
        <Table>
          <TableHeader>
            <TableRow>
              <th>Filename</th>
              <th>Size</th>
              <th>Status</th>
              <th>Created</th>
              <th></th>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((document) => (
              <TableRow key={document.id}>
                <TableCell>{document.filename}</TableCell>
                <TableCell>{document.size_bytes} bytes</TableCell>
                <TableCell>{document.state}</TableCell>
                <TableCell>{DateTime.toDateUtc(document.created_at).toLocaleString()}</TableCell>
                <TableCell>
                  {document.state === "stored" && (
                    <Button onClick={() => download(document.id, document.filename)}>Download</Button>
                  )}{" "}
                  <Button onClick={() => remove(document.id)}>Delete</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}