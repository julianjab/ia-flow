import { getActionHandler } from '@ia-flow/rules'
import { NamedActionSchema } from '@ia-flow/shared'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { actionRepo, projectRepo, ruleRepo } from '../composition/container.js'

// CRUD de acciones con nombre. Mismo criterio de scope que `rules` y
// `agents-crud`: el ámbito viaja por query y no se deduce del body, para que
// una escritura no pueda promover en silencio una acción de proyecto a global.

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

/** Una acción de OTRO ámbito. 409 y no 404: existe, se ve, y el mensaje dice
 *  dónde se edita — un 404 haría pensar que se borró. */
function foreignScopeResponse(c: Context, existing: { projectId?: string | null }) {
  return c.json(
    {
      error:
        existing.projectId == null
          ? 'Es una acción global: para modificarla, editala desde General'
          : `Es una acción del proyecto '${existing.projectId}'`,
    },
    409,
  )
}

function readOnlyResponse(c: Context) {
  return c.json({ error: 'El repositorio de acciones es de sólo lectura (deploy por YAML)' }, 409)
}

/**
 * Qué reglas referencian esta acción.
 *
 * Se usa para NO borrar a ciegas. Un `DELETE` que rompe tres reglas en silencio
 * es el peor modo de falla de este modelo: nada da error, las reglas siguen
 * matcheando, y la acción simplemente no pasa.
 */
async function usedBy(actionId: string, projectId: string | null): Promise<string[]> {
  const rules = await ruleRepo.list(
    projectId === null ? { global: true } : { projectId: projectId },
  )
  return rules
    .filter((r) =>
      (r.do ?? []).some(
        (a) =>
          (a as { action: string; actionId?: string }).action === 'ref' &&
          (a as { actionId?: string }).actionId === actionId,
      ),
    )
    .map((r) => r.id)
}

export function createActionsRouter() {
  const router = new Hono()

  // `actions` son las de ESTE ámbito e `inherited` las globales que el proyecto
  // ve por herencia — las dos referenciables desde una regla suya, así que
  // devolver sólo las propias escondía la mitad del vocabulario. Mismo criterio
  // que `rules.ts` y `tools-crud.ts`.
  router.get('/', async (c) => {
    const s = resolveScope(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    const actions = await actionRepo.list(
      s.target === null ? { global: true } : { projectId: s.target },
    )
    const inherited = s.target === null ? [] : await actionRepo.list({ global: true })
    return c.json({ actions, inherited, readOnly: actionRepo.isReadOnly() })
  })

  router.post('/', async (c) => {
    const s = resolveScope(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    if (actionRepo.isReadOnly()) return readOnlyResponse(c)

    const parsed = NamedActionSchema.safeParse({ ...(await c.req.json()), projectId: s.target })
    if (!parsed.success) {
      return c.json({ error: 'Payload inválido', issues: parsed.error.issues }, 400)
    }

    if (await actionRepo.getById(parsed.data.id)) {
      return c.json({ error: `Ya existe una acción con id '${parsed.data.id}'` }, 409)
    }

    // El daemon tiene que saber ejecutar el kind. Sin esto, la acción se guarda
    // bien y falla recién en el primer evento — el modo de falla más caro,
    // porque es silencioso.
    if (!getActionHandler(parsed.data.body.action)) {
      return c.json(
        { error: `Este daemon no sabe ejecutar acciones de tipo '${parsed.data.body.action}'` },
        400,
      )
    }

    return c.json({ action: await actionRepo.upsert(parsed.data) }, 201)
  })

  router.put('/:id', async (c) => {
    const s = resolveScope(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    if (actionRepo.isReadOnly()) return readOnlyResponse(c)

    const id = c.req.param('id')
    const existing = await actionRepo.getById(id)
    if (!existing) return c.json({ error: `No existe la acción '${id}'` }, 404)
    // Una acción heredada se VE desde el proyecto, no se edita ahí: el cambio
    // afectaría a todos los proyectos desde una pantalla que muestra uno solo.
    // Mismo criterio que `rules.ts`.
    if ((existing.projectId ?? null) !== s.target) return foreignScopeResponse(c, existing)

    const parsed = NamedActionSchema.safeParse({
      ...(await c.req.json()),
      // El id y el ámbito NO se editan: cambiarlos rompería toda regla que la
      // referencia, en silencio. Para mover una acción de ámbito hay que
      // crearla en el nuevo y borrar la vieja, que fuerza a mirar quién la usa.
      id,
      projectId: existing.projectId ?? null,
      createdAt: existing.createdAt,
    })
    if (!parsed.success) {
      return c.json({ error: 'Payload inválido', issues: parsed.error.issues }, 400)
    }
    if (!getActionHandler(parsed.data.body.action)) {
      return c.json(
        { error: `Este daemon no sabe ejecutar acciones de tipo '${parsed.data.body.action}'` },
        400,
      )
    }

    return c.json({ action: await actionRepo.upsert(parsed.data) })
  })

  // DELETE /api/actions/:id[?force=1]
  //
  // Se niega si alguna regla la referencia, y devuelve CUÁLES. `force=1` borra
  // igual — hay casos legítimos (limpiar reglas ya rotas), pero tienen que ser
  // una decisión y no el default.
  router.delete('/:id', async (c) => {
    const s = resolveScope(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    if (actionRepo.isReadOnly()) return readOnlyResponse(c)

    const id = c.req.param('id')
    const existing = await actionRepo.getById(id)
    if (!existing) return c.json({ error: `No existe la acción '${id}'` }, 404)
    if ((existing.projectId ?? null) !== s.target) return foreignScopeResponse(c, existing)

    const users = await usedBy(id, s.target)
    if (users.length && c.req.query('force') !== '1') {
      return c.json(
        {
          error: `La usan ${users.length} regla(s): ${users.join(', ')}`,
          usedBy: users,
        },
        409,
      )
    }

    const ok = await actionRepo.deleteById(id)
    if (!ok) return c.json({ error: `No existe la acción '${id}'` }, 404)
    return c.json({ ok: true, brokeRules: users })
  })

  return router
}
