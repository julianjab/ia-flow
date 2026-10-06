import {
  type ImprovementDecisionResult,
  ImprovementDecisionResultSchema,
  type ImprovementList,
  ImprovementListSchema,
  type ImprovementStatus,
} from '@ia-flow/shared'
import axios from 'axios'

/**
 * Las mejoras propuestas. Un runner viejo (404) o que no las guarda (501) devuelve `null`: para la
 * bandeja es «no hay», sin error visible.
 */
export async function getImprovements(
  status: ImprovementStatus | 'all' = 'open',
): Promise<ImprovementList | null> {
  const res = await axios.get<unknown>('/api/improvements', {
    params: { status },
    validateStatus: (code) => code < 500 || code === 501,
  })
  if (res.status === 404 || res.status === 501) return null
  if (res.status >= 400) throw new Error(`El runner respondió ${res.status} en /api/improvements`)
  return ImprovementListSchema.parse(res.data)
}

/**
 * Abrir o descartar una mejora, firmado con el token de GitHub del USUARIO (`x-github-token`).
 * Un rechazo (401, 403, 404, 409) llega con el mismo cuerpo y `ok: false`: se devuelve para
 * mostrar su mensaje. Sólo lo que no tiene esa forma se lanza.
 */
async function decide(
  id: string,
  verb: 'open' | 'dismiss',
  githubToken: string,
): Promise<ImprovementDecisionResult> {
  const res = await axios.post<unknown>(
    `/api/improvements/${encodeURIComponent(id)}/${verb}`,
    undefined,
    { headers: { 'x-github-token': githubToken }, validateStatus: (code) => code < 500 },
  )
  const parsed = ImprovementDecisionResultSchema.safeParse(res.data)
  if (parsed.success) return parsed.data
  throw new Error(`El runner respondió ${res.status} sin un resultado legible`)
}

export const openImprovement = (id: string, githubToken: string) => decide(id, 'open', githubToken)
export const dismissImprovement = (id: string, githubToken: string) =>
  decide(id, 'dismiss', githubToken)
