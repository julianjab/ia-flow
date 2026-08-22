import axios from 'axios'

// A plain axios error's `.message` is generic ("Request failed with status
// code 400") — it never carries the server's `{ error: "..." }` body, which
// is where routes put anything actually actionable (e.g. a Yaml*Repository's
// "es de solo lectura — editá el archivo YAML y reiniciá el proceso").
// Every feature that reports a failed API call should go through this
// instead of `e instanceof Error ? e.message : String(e)`.
export function extractErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string; message?: string } | undefined
    return data?.error ?? data?.message ?? err.message
  }
  if (err instanceof Error) return err.message
  return String(err)
}
