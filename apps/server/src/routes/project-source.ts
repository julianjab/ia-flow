import type { Blocker, ProjectSource, SourceItem } from '@ia-flow/issue-sources'
import { defaultToIssueItem } from '@ia-flow/issue-sources'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { projectRepo, sourceFactory } from '../composition/container.js'
import { createLogger } from '../logger.js'

const log = createLogger('project-source')

/** Tope del batch de blockers. No es una paginación: es el freno para que un
 *  `?ids=` armado a mano no dispare cientos de llamadas a la fuente. Un
 *  listado real pide como mucho las filas que muestra. */
const MAX_BLOCKER_IDS = 100

// Sub-router mounted at /api/projects/:id/source. Every endpoint resolves the
// project row → its ProjectSource, so callers never talk to a specific
// provider (github, linear, ...). Behaviour on projects with no configured
// source: 200 with an empty payload — the UI treats that the same as
// "provider not connected yet".

function withProject(c: Context) {
  const id = c.req.param('id') ?? ''
  const project = id ? projectRepo.get(id) : null
  return { id, project }
}

/**
 * Los `SourceItem` de `ids`, resueltos contra el snapshot y, para los que
 * falten, por lookup directo — igual que hace la ruta por item, así el
 * batch no contradice al detalle sobre la misma tarea.
 */
async function resolveWantedItems(source: ProjectSource, ids: string[]): Promise<SourceItem[]> {
  const items = await source.getItems()
  const byId = new Map(items.map((i) => [i.id, i]))
  // Lo que quede sin resolver de verdad NO entra al mapa: su ausencia
  // significa "no sé", que es lo que es.
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length && source.getItemById) {
    const found = await Promise.all(missing.map((id) => source.getItemById?.(id).catch(() => null)))
    for (const item of found) if (item) byId.set(item.id, item)
  }
  return ids.map((id) => byId.get(id)).filter((i): i is SourceItem => i !== undefined)
}

/** Los blockers de cada item, con un pool de 5 — el `getBlockers` de GitHub
 *  es una request por issue. Un fallo por item NO tira la respuesta entera:
 *  la clave simplemente no aparece, y "no sé" se distingue de "no hay". */
async function fetchBlockersBatch(
  source: ProjectSource & { getBlockers: NonNullable<ProjectSource['getBlockers']> },
  wanted: SourceItem[],
): Promise<Record<string, Blocker[]>> {
  const blockers: Record<string, Blocker[]> = {}
  const queue = [...wanted]
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const issueItem = source.toIssueItem ? source.toIssueItem(item) : defaultToIssueItem(item)
      try {
        // Llamado como método (`source.getBlockers(...)`), no desatado: las
        // implementaciones reales usan `this` adentro.
        blockers[item.id] = await source.getBlockers(issueItem)
      } catch (err) {
        log.warn(
          { err: (err as Error).message, itemId: item.id },
          'getBlockers falló para un item del batch — se omite del mapa',
        )
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, wanted.length) }, worker))
  return blockers
}

async function findSourceItem(source: ProjectSource, itemId: string): Promise<SourceItem | null> {
  const direct = source.getItemById ? await source.getItemById(itemId) : null
  if (direct) return direct
  const items = await source.getItems()
  return items.find((i) => i.id === itemId) ?? null
}

// Convert SourceItem → IssueItem (matches PollingIssueManager.toIssueItem
// enough for the blocker lookup; description is what the local source
// needs, meta.issueNumber+repoName is what github needs).
function toIssueItemFor(source: ProjectSource, sourceItem: SourceItem) {
  if (source.toIssueItem) return source.toIssueItem(sourceItem)
  return {
    id: sourceItem.id,
    title: sourceItem.title,
    description: (sourceItem.meta?.description as string) ?? '',
    type: (sourceItem.meta?.type as string) ?? '',
    repos: sourceItem.repos ? sourceItem.repos.split(',').map((r) => r.trim()) : [],
    status: sourceItem.status,
    meta: sourceItem.meta,
  }
}

export function createProjectSourceRouter() {
  const router = new Hono()

  // Diagnostic: is the project's source correctly configured for the daemon?
  // Returns { ok, missing[], warnings[], message? } — see ProjectSource.getHealth.
  router.get('/health', async (c) => {
    const { project } = withProject(c)
    if (!project) return c.json({ error: 'Project not found', ok: false }, 404)
    try {
      const source = sourceFactory.get(project)
      if (!source.getHealth) {
        return c.json({ ok: true, kind: source.kind, missing: [], warnings: [] })
      }
      const health = await source.getHealth()
      return c.json({ kind: source.kind, ...health })
    } catch (err) {
      return c.json({ ok: false, missing: [], warnings: [], message: (err as Error).message }, 502)
    }
  })

  router.get('/fields', async (c) => {
    const { project } = withProject(c)
    if (!project) return c.json({ error: 'Project not found', fields: [] }, 404)
    const refresh = c.req.query('refresh') === '1'
    try {
      const source = sourceFactory.get(project)
      // Fallback for sources that don't implement getFields: expose a synthetic
      // Status field derived from getStatuses so the UI always has something.
      if (!source.getFields) {
        const statuses = await source.getStatuses({ refresh })
        return c.json({
          kind: source.kind,
          fields: [
            { name: 'Status', dataType: 'SINGLE_SELECT', options: statuses.map((s) => s.name) },
          ],
        })
      }
      const fields = await source.getFields({ refresh })
      return c.json({ kind: source.kind, fields })
    } catch (err) {
      return c.json({ error: (err as Error).message, fields: [] }, 502)
    }
  })

  router.get('/statuses', async (c) => {
    const { project } = withProject(c)
    if (!project) return c.json({ error: 'Project not found', statuses: [] }, 404)
    const refresh = c.req.query('refresh') === '1'
    try {
      const source = sourceFactory.get(project)
      const statuses = await source.getStatuses({ refresh })
      return c.json({ kind: source.kind, statuses })
    } catch (err) {
      return c.json({ error: (err as Error).message, statuses: [] }, 502)
    }
  })

  router.get('/items', async (c) => {
    const { project } = withProject(c)
    if (!project) return c.json({ error: 'Project not found', items: [] }, 404)
    const refresh = c.req.query('refresh') === '1'
    const status = c.req.query('status') ?? undefined
    try {
      const source = sourceFactory.get(project)
      const items = await source.getItems({ status, refresh })
      return c.json({ kind: source.kind, items })
    } catch (err) {
      return c.json({ error: (err as Error).message, items: [] }, 502)
    }
  })

  // GET /api/projects/:id/source/blockers?ids=a,b,c
  // Los blockers de varias tareas de una. La ruta por item sigue existiendo
  // (la usa el detalle); esto es para un LISTADO, donde item por item eran
  // tantas requests como filas.
  //
  // El ahorro real es doble: una sola resolución de items (`getItems`, o
  // `getItemById` cuando la fuente lo tiene) en vez de una por id, y una sola
  // request del browser. Las llamadas que la fuente haga por dentro siguen
  // siendo suyas — acá se acotan con un pool de concurrencia para no abrirle
  // 40 conexiones a GitHub de golpe.
  router.get('/blockers', async (c) => {
    const { project } = withProject(c)
    if (!project) return c.json({ error: 'Project not found', blockers: {} }, 404)
    const ids = (c.req.query('ids') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
    if (!ids.length) return c.json({ error: 'ids query param is required', blockers: {} }, 400)
    if (ids.length > MAX_BLOCKER_IDS) {
      return c.json({ error: `Too many ids (max ${MAX_BLOCKER_IDS})`, blockers: {} }, 400)
    }

    try {
      const source = sourceFactory.get(project)
      // Sin `getBlockers` la respuesta es un mapa vacío, no un error: una
      // fuente que no modela dependencias no está rota — la UI simplemente no
      // puede afirmar "bloqueada", que es distinto de afirmar "no bloqueada".
      if (!source.getBlockers) return c.json({ kind: source.kind, blockers: {} })

      const wanted = await resolveWantedItems(source, ids)
      const blockers = await fetchBlockersBatch(
        source as ProjectSource & { getBlockers: NonNullable<ProjectSource['getBlockers']> },
        wanted,
      )

      return c.json({ kind: source.kind, blockers })
    } catch (err) {
      return c.json({ error: (err as Error).message, blockers: {} }, 502)
    }
  })

  router.get('/items/:itemId/blockers', async (c) => {
    const { project } = withProject(c)
    if (!project) return c.json({ error: 'Project not found', blockers: [] }, 404)
    const itemId = c.req.param('itemId')
    try {
      const source = sourceFactory.get(project)
      if (!source.getBlockers) return c.json({ kind: source.kind, blockers: [] })
      const sourceItem = await findSourceItem(source, itemId)
      if (!sourceItem) return c.json({ error: 'Item not found', blockers: [] }, 404)
      const issueItem = toIssueItemFor(source, sourceItem)
      const blockers = await source.getBlockers(issueItem)
      return c.json({ kind: source.kind, blockers })
    } catch (err) {
      return c.json({ error: (err as Error).message, blockers: [] }, 502)
    }
  })

  router.patch('/items/:itemId/:field', async (c) => {
    const { project } = withProject(c)
    if (!project) return c.json({ error: 'Project not found' }, 404)
    const itemId = c.req.param('itemId')
    const field = c.req.param('field')
    const body = await c.req.json<{ value: unknown }>().catch(() => null)
    if (!body || typeof body.value !== 'string') {
      return c.json({ error: 'body.value (string) required' }, 400)
    }
    try {
      const source = sourceFactory.get(project)
      if (!source.setItemField) {
        return c.json({ error: `Source '${source.kind}' does not support field updates` }, 501)
      }
      await source.setItemField(itemId, field, body.value)
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502)
    }
  })

  return router
}
