import { parseCron, registeredActionKinds, validateActions } from '@ia-flow/rules'
import { RuleInputSchema, toggleDisabledRuleId } from '@ia-flow/shared'
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

/** Los ids que el proyecto dio de baja, ya normalizados: `settings` es un bag
 *  `unknown`, así que se valida en vez de castear. */
function disabledRuleIdsOf(projectId: string): string[] {
  const raw = projectRepo.get(projectId)?.settings?.disabledRuleIds
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

const ProjectEnabledSchema = z.object({
  projectId: z.string().min(1),
  enabled: z.boolean(),
})

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
    // Cuáles de las heredadas este proyecto dio de baja. Viaja al lado de
    // `inherited` y no dentro de cada regla porque NO es de la regla: la misma
    // fila la ven todos los proyectos, y cada uno decide aparte.
    //
    // `inherited` sale de `list()` —sin filtrar—, así que una dada de baja
    // sigue en la lista: es lo que la pantalla necesita para poder volver a
    // darla de alta. Filtrarla acá la haría irreversible desde la UI.
    const disabledHere = s.target === null ? [] : disabledRuleIdsOf(s.target)
    return c.json({ rules, inherited, disabledHere, readOnly: ruleRepo.isReadOnly() })
  })

  /**
   * Dar de baja (o de alta) una regla GLOBAL en un proyecto.
   *
   * Vive en el router de reglas y no en el de proyectos porque es la respuesta
   * a una pregunta sobre una regla, y es donde el operador ya está parado
   * cuando la hace.
   *
   * ── Por qué el server hace el add/remove y no recibe la lista ────────────
   *
   * Porque `settings.disabledRuleIds` es una lista compartida por todas las
   * reglas del proyecto. Si el cliente mandara la lista entera, dos pestañas
   * apagando reglas distintas se pisarían: la segunda escribiría su copia, ya
   * vieja, y desharía la baja de la primera sin que nada fallara. Mandando el
   * id y la intención, la única lectura-escritura ocurre acá.
   *
   * Sólo aplica a reglas GLOBALES: una propia del proyecto se apaga con su
   * `enabled`, que es donde el operador ya lo busca. Pedirlo sobre una propia
   * es un 400 y no un no-op silencioso — el no-op deja creyendo que funcionó.
   */
  router.put('/:id/project-enabled', async (c) => {
    const id = c.req.param('id')
    const body = ProjectEnabledSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'Body inválido: { projectId, enabled }' }, 400)
    const { projectId, enabled } = body.data

    const project = projectRepo.get(projectId)
    if (!project) return c.json({ error: `Proyecto ${projectId} no existe` }, 404)

    const rule = await ruleRepo.getById(id)
    if (!rule) return c.json({ error: `La regla ${id} no existe` }, 404)
    if (rule.projectId != null) {
      return c.json(
        { error: `La regla ${id} es propia de un proyecto — se apaga con su campo "enabled"` },
        400,
      )
    }
    // Una global AGENDADA no dispara "en un proyecto": el productor de cron
    // emite su tick con el scope de la regla, y el de una global es vacío
    // (`scheduleTickEvent` → `scope: {}`). O sea que corre una vez para todo el
    // proceso, y `visibleTo(undefined)` —el camino que toma ese evento— no
    // tiene proyecto contra el cual filtrar.
    //
    // Se rechaza en vez de aceptarse y no hacer nada: guardar la baja dejaría
    // el interruptor apagado mientras la regla sigue disparando, que es el
    // fallo silencioso que este endpoint existe para no tener.
    if (rule.schedule) {
      return c.json(
        {
          error: `La regla ${id} corre por cron y no por proyecto — no hay un "acá" que apagar. Si su tick tiene que afectar sólo a algunos proyectos, que emita un evento con scope y la baja se hace sobre la regla que lo consume.`,
        },
        400,
      )
    }

    const current = disabledRuleIdsOf(projectId)
    const next = toggleDisabledRuleId(current, id, enabled)
    try {
      projectRepo.upsert({
        id: project.id,
        name: project.name,
        language: project.language,
        source: project.source,
        // Merge por key, igual que el PATCH del proyecto: `settings` es un bag
        // compartido entre features y pisarlo entero se llevaría puesto el gate
        // de polling, el cap de dispatches y la config de Slack.
        settings: { ...(project.settings ?? {}), disabledRuleIds: next },
      })
    } catch (err) {
      // Un deploy headless define sus proyectos por YAML y el repo tira al
      // escribir. Se traduce a un 409 con el motivo en vez de un 500: no es un
      // fallo, es que este deploy no se configura desde acá — el mismo trato
      // que le da el CRUD de reglas a su repo de sólo lectura.
      return c.json({ error: String(err) }, 409)
    }
    return c.json({ disabledHere: next })
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
