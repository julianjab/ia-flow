// Pide a Claude un nombre de branch git legible para una task, cuando el
// engine necesita auto-crear una linked branch en GitHub (Development panel
// vacío + primer agente con write tools).
//
// Reutiliza los primitives del provider anthropic para no duplicar la
// auth ni la URL base. Modelo hardcoded: haiku 4.5 (barato, rápido).
// Fallback determinístico: si el API call falla o el output se sanea a vacío,
// devuelve `task/<taskId>`.

import { ANTHROPIC_API_URL, buildAnthropicHeaders } from '../adapters/anthropic/auth.js'
import { getDb } from '../infrastructure/db/database.js'
import { createLogger } from '../logger.js'

const log = createLogger('branch-namer')

const MODEL = 'claude-haiku-4-5'
const MAX_TOKENS = 60

/**
 * Recupera el system prompt `claudeCodeIdentity` (mismo texto que usan los
 * agentes cuando se corren via anthropic-api). Se lee directo del DB para
 * evitar el ciclo application → composition/container → application.
 * Devuelve null si no está seedeado (edge case: bootstrap fresco).
 */
function loadClaudeCodeIdentity(): string | null {
  try {
    const row = getDb()
      .query('SELECT text FROM system_prompts WHERE id = ? LIMIT 1')
      .get('claudeCodeIdentity') as { text: string } | null
    return row?.text ?? null
  } catch (err) {
    log.warn({ err }, 'Failed to load claudeCodeIdentity from DB — running without identity')
    return null
  }
}

export interface BranchNamerTask {
  id: string
  title: string
  description?: string
  type?: string
}

/**
 * Sanea el string devuelto por el modelo a un nombre válido de git ref.
 *   • minúsculas
 *   • solo alfanuméricos, `/`, `-`, `_`
 *   • sin dobles guiones ni guiones/`/` en bordes de segmento
 *   • máximo 80 chars
 * Devuelve string vacío si no queda nada útil (el caller aplica fallback).
 */
export function sanitizeBranchName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/["'`]/g, '')
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/-+/g, '-')
    .replace(/\/-+|-+\//g, '/')
    .replace(/^[-/]+|[-/]+$/g, '')
    .slice(0, 80)
  return cleaned
}

function buildPrompt(task: BranchNamerTask): string {
  const desc = (task.description ?? '').slice(0, 500)
  const type = task.type ?? 'functional'
  return [
    'Generá un nombre de branch git para esta task.',
    '',
    `Título: ${task.title}`,
    `Tipo: ${type}`,
    desc ? `Descripción (resumen): ${desc}` : '',
    `Task ID: ${task.id}`,
    '',
    'Reglas estrictas:',
    `- Formato: <prefijo>/<slug-descriptivo>-${task.id}`,
    '- Prefijo permitido: feat | fix | chore | refactor | docs (elegilo según tipo/descripción; functional → feat por defecto)',
    '- Slug: kebab-case, minúsculas, sin acentos, máximo 40 chars, describe la acción principal',
    '- Sin espacios, sin dobles guiones, sin puntos, sin comillas, sin markdown',
    '',
    'Respondé SOLO con el nombre de la branch, nada más.',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Llama a Claude Haiku y devuelve un nombre de branch saneado. Nunca throw:
 * cualquier error de red / rate limit / parseo cae al fallback `task/<id>`.
 */
export async function proposeLinkedBranchName(
  task: BranchNamerTask,
  opts: { fetch?: typeof fetch; systemText?: string } = {},
): Promise<string> {
  const fallback = `task/${task.id}`
  const fetchImpl = opts.fetch ?? fetch
  let headers: Record<string, string>
  try {
    headers = buildAnthropicHeaders()
  } catch (err) {
    log.warn({ err, taskId: task.id }, 'No Anthropic auth — using fallback branch name')
    return fallback
  }

  // Identidad Claude Code: mismo system prompt que reciben los agentes cuando
  // corren via anthropic-api. Alinea el registro del one-shot con el resto
  // de llamadas server-side. `opts.systemText` permite override en tests.
  const identity = opts.systemText ?? loadClaudeCodeIdentity()

  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user' as const, content: buildPrompt(task) }],
  }
  if (identity) {
    body.system = [{ type: 'text' as const, text: identity }]
  }

  try {
    const res = await fetchImpl(ANTHROPIC_API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      log.warn(
        { status: res.status, taskId: task.id },
        'Anthropic API returned non-2xx — using fallback branch name',
      )
      return fallback
    }
    const json = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>
    }
    const rawText = (json.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('')
      .trim()
    const sanitized = sanitizeBranchName(rawText)
    if (!sanitized) {
      log.warn({ taskId: task.id, rawText }, 'Sanitized branch name empty — using fallback')
      return fallback
    }
    log.info({ taskId: task.id, branch: sanitized }, 'Proposed branch name from Claude')
    return sanitized
  } catch (err) {
    log.warn({ err, taskId: task.id }, 'Anthropic branch-namer failed — using fallback')
    return fallback
  }
}
