import { parseCron, registeredActionKinds, validateActions } from '@ia-flow/rules'
import { RuleInputSchema } from '@ia-flow/shared'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import { actionRepo, projectRepo, ruleRepo } from '../composition/container.js'

const ReorderRequestSchema = z.object({ ids: z.array(z.string()) })

// Mismo criterio de scope que `agents-crud`: una regla es global o de un
// proyecto, y el ámbito viaja por query en vez de deducirse del body — así una
// escritura no puede promover en silencio una regla global a una de proyecto.
function resolveScope(
  c: Context,
): { ok: true; target: string | null } | { ok: false; error: string } {
  const scope = c.req.query('scope')
  if (scope === 'global') return { ok: true, target: null }
  const projectId = c.req.query('projectId')
  if (!projectId) return { ok: false, error: 'scope=global o projectId=<id> es obligatorio' }
  if (!projectRepo.get(projectId)) return { ok: false, error: `Proyecto ${projectId} no existe` }
  return { ok: true, target: projectId }
}

/**
 * Las refs del `do[]` que no resuelven en este ámbito.
 *
 * Se valida al GUARDAR y no sólo al ejecutar porque una ref rota es
 * silenciosa: la regla matchea, corre, y la acción simplemente no pasa. El
 * runner igual la vuelve a chequear —alguien puede borrar la acción después—
 * pero ahí ya es tarde para avisarle a quien la escribió.
 */
async function danglingRefs(
  actions: readonly { action: string; actionId?: string }[],
  projectId: string | null,
): Promise<string[]> {
  const refs = actions.filter((a) => a.action === 'ref').map((a) => a.actionId ?? '')
  if (!refs.length) return []
  const visible = new Set((await actionRepo.visibleTo(projectId ?? undefined)).map((a) => a.id))
  return [...new Set(refs.filter((id) => !visible.has(id)))]
}

function readOnlyResponse(c: Context) {
  return c.json({ error: 'El repositorio de reglas es de sólo lectura (deploy por YAML)' }, 409)
}

export function createRulesRouter() {
  const router = new Hono()

  /** Los tipos de acción que este daemon sabe ejecutar. Lo consume el editor
   *  para no ofrecer una acción que no existe — sin esto, el operador puede
   *  guardar una regla que falla recién en el primer evento, que es el modo de
   *  falla más caro porque es silencioso. */
  //
  // `ref` se suma a mano: NO es un kind del registry —se resuelve antes del
  // dispatch, ver `runRule`— pero el editor tiene que poder ofrecerlo. Sin
  // esto la única forma de escribir una referencia sería editar el JSON.
  router.get('/action-kinds', (c) => c.json({ kinds: [...registeredActionKinds(), 'ref'] }))

  // GET /api/rules?scope=global|projectId=X
  //
  // Dos listas y no una: `rules` son las de ESTE ámbito —editables acá— e
  // `inherited` las globales que el proyecto ve por herencia. Ambas disparan
  // sobre los eventos del proyecto (`visibleTo`), así que devolver sólo las
  // propias mostraba media configuración: el operador veía un pipeline vacío
  // mientras cinco reglas globales trabajaban sobre sus issues.
  //
  // En el ámbito global `inherited` es siempre vacío — ahí las globales SON las
  // propias.
  router.get('/', async (c) => {
    const s = resolveScope(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    const rules = await ruleRepo.list(
      s.target === null ? { global: true } : { projectId: s.target },
    )
    const inherited = s.target === null ? [] : await ruleRepo.list({ global: true })
    return c.json({ rules, inherited, readOnly: ruleRepo.isReadOnly() })
  })

  router.post('/', async (c) => {
    const s = resolveScope(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    if (ruleRepo.isReadOnly()) return readOnlyResponse(c)

    const parsed = RuleInputSchema.safeParse(await c.req.json())
    if (!parsed.success)
      return c.json({ error: 'Payload inválido', issues: parsed.error.issues }, 400)

    const id = parsed.data.id ?? crypto.randomUUID()
    if (await ruleRepo.getById(id)) return c.json({ error: `La regla '${id}' ya existe` }, 409)

    // Validar el `do[]` acá y no al ejecutar: una regla que referencia una
    // acción inexistente tiene que fallar al guardarse, con un mensaje que
    // diga qué acción y en qué posición.
    const errors = validateActions(parsed.data.do)
    if (errors.length) return c.json({ error: 'Acciones inválidas', details: errors }, 400)

    const dangling = await danglingRefs(
      parsed.data.do as { action: string; actionId?: string }[],
      s.target,
    )
    if (dangling.length) {
      return c.json(
        { error: `Estas acciones no existen en este ámbito: ${dangling.join(', ')}`, dangling },
        400,
      )
    }

    // El cron se valida acá y no al primer tick: una expresión rota que sólo
    // falla en runtime es una regla que nunca dispara y nadie sabe por qué.
    if (parsed.data.schedule && !parseCron(parsed.data.schedule)) {
      return c.json({ error: `Expresión cron inválida: '${parsed.data.schedule}'` }, 400)
    }

    const saved = await ruleRepo.upsert({ ...parsed.data, id, projectId: s.target })
    return c.json({ rule: saved }, 201)
  })

  router.put('/reorder', async (c) => {
    const s = resolveScope(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    if (ruleRepo.isReadOnly()) return readOnlyResponse(c)

    const parsed = ReorderRequestSchema.safeParse(await c.req.json())
    if (!parsed.success)
      return c.json({ error: 'Payload inválido', issues: parsed.error.issues }, 400)

    // Sólo se reordena dentro del ámbito pedido: aceptar ids de otro scope
    // renumeraría una lista que el operador no está viendo.
    const inScope = new Set(
      (await ruleRepo.list(s.target === null ? { global: true } : { projectId: s.target })).map(
        (r) => r.id,
      ),
    )
    const unknown = parsed.data.ids.filter((id) => !inScope.has(id))
    if (unknown.length) return c.json({ error: `Ids fuera del ámbito: ${unknown.join(', ')}` }, 400)

    await ruleRepo.setPositions(parsed.data.ids)
    return c.json({ ok: true })
  })

  router.put('/:id', async (c) => {
    const s = resolveScope(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    if (ruleRepo.isReadOnly()) return readOnlyResponse(c)

    const id = c.req.param('id')
    const existing = await ruleRepo.getById(id)
    if (!existing) return c.json({ error: `La regla '${id}' no existe` }, 404)
    if ((existing.projectId ?? null) !== s.target)
      return c.json({ error: `La regla '${id}' no pertenece a este ámbito` }, 409)

    const parsed = RuleInputSchema.safeParse(await c.req.json())
    if (!parsed.success)
      return c.json({ error: 'Payload inválido', issues: parsed.error.issues }, 400)

    const errors = validateActions(parsed.data.do)
    if (errors.length) return c.json({ error: 'Acciones inválidas', details: errors }, 400)

    const dangling = await danglingRefs(
      parsed.data.do as { action: string; actionId?: string }[],
      s.target,
    )
    if (dangling.length) {
      return c.json(
        { error: `Estas acciones no existen en este ámbito: ${dangling.join(', ')}`, dangling },
        400,
      )
    }
    if (parsed.data.schedule && !parseCron(parsed.data.schedule)) {
      return c.json({ error: `Expresión cron inválida: '${parsed.data.schedule}'` }, 400)
    }

    // La posición NO viaja en el update: editar una regla no debería
    // reordenar la lista bajo los pies del operador. Para eso está /reorder.
    const saved = await ruleRepo.upsert({
      ...parsed.data,
      id,
      projectId: s.target,
      position: existing.position,
    })
    return c.json({ rule: saved })
  })

  router.delete('/:id', async (c) => {
    const s = resolveScope(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    if (ruleRepo.isReadOnly()) return readOnlyResponse(c)

    const id = c.req.param('id')
    const existing = await ruleRepo.getById(id)
    if (!existing) return c.json({ error: `La regla '${id}' no existe` }, 404)
    if ((existing.projectId ?? null) !== s.target)
      return c.json({ error: `La regla '${id}' no pertenece a este ámbito` }, 409)

    await ruleRepo.deleteById(id)
    return c.json({ ok: true })
  })

  return router
}
