import { EditableToolSchema } from '@ia-flow/shared'
import { getAllTools } from '@ia-flow/tools'
import { Hono } from 'hono'
import { actionRepo, toolRepo } from '../composition/container.js'
import { applyEditableTools, isBuiltInName } from '../composition/editable-tools.js'
import { createLogger } from '../logger.js'

const log = createLogger('tools-crud')

// CRUD de tools editables.
//
// Sin scope por query, a diferencia de reglas y acciones: el nombre de una tool
// es global (ver `ToolNameSchema`), así que no hay ámbito contra el cual acotar.

/** Re-aplica todo sobre el registry. Se llama después de cada escritura: editar
 *  una descripción tiene que valer para el próximo dispatch, no para el próximo
 *  reinicio. */
async function reapply() {
  await applyEditableTools({
    listTools: () => toolRepo.list(),
    getAction: (id) => actionRepo.getById(id),
  })
}

export function createToolsCrudRouter() {
  const router = new Hono()

  // GET /api/tools-crud — lo editable MÁS las built-in, para que la UI pueda
  // mostrar cuáles se pueden ajustar y cuáles no sin cruzar dos endpoints.
  router.get('/', async (c) => {
    const editable = await toolRepo.list()
    const overrides = new Map(
      editable.filter((t) => t.kind === 'override').map((t) => [t.name, t.description]),
    )
    return c.json({
      editable,
      builtIns: getAllTools()
        .filter((t) => !editable.some((e) => e.kind === 'defined' && e.name === t.name))
        .map((t) => ({
          name: t.name,
          description: t.description,
          // Para poder mostrar "overrideada" y ofrecer revertir: una
          // descripción mal editada degrada en silencio a todos los agentes que
          // usan esa tool, y ningún test lo agarra.
          overridden: overrides.has(t.name),
        })),
      readOnly: toolRepo.isReadOnly(),
    })
  })

  router.put('/:name', async (c) => {
    if (toolRepo.isReadOnly()) {
      return c.json({ error: 'El repositorio de tools es de sólo lectura (deploy por YAML)' }, 409)
    }

    const name = c.req.param('name')
    const parsed = EditableToolSchema.safeParse({ ...(await c.req.json()), name })
    if (!parsed.success) {
      return c.json({ error: 'Payload inválido', issues: parsed.error.issues }, 400)
    }
    const tool = parsed.data

    if (tool.kind === 'defined') {
      // Tapar una built-in cambiaría en silencio lo que hace un agente que la
      // declara — el modo de falla más caro de esta feature.
      if (isBuiltInName(name)) {
        const existing = await toolRepo.getByName(name)
        if (existing?.kind !== 'defined') {
          return c.json(
            {
              error: `'${name}' es una tool built-in: no se puede reemplazar, sólo ajustar su descripción (kind: override)`,
            },
            409,
          )
        }
      }
      if (!(await actionRepo.getById(tool.actionId))) {
        return c.json({ error: `La acción '${tool.actionId}' no existe` }, 400)
      }
    } else if (!isBuiltInName(name)) {
      // Una override sobre algo que no existe no ajusta nada, y guardarla haría
      // creer que sí.
      return c.json({ error: `No hay ninguna tool built-in llamada '${name}'` }, 404)
    }

    const saved = await toolRepo.upsert(tool)
    await reapply()
    log.info({ name, kind: tool.kind }, 'Tool editable guardada')
    return c.json({ tool: saved })
  })

  // DELETE — para una `override`, revertir a la descripción del código.
  //
  // El revert NO se puede hacer en caliente: la built-in ya tiene su
  // descripción pisada en el registry del proceso, y el texto original vive
  // sólo en el código. Se avisa explícitamente en vez de fingir que volvió.
  router.delete('/:name', async (c) => {
    if (toolRepo.isReadOnly()) {
      return c.json({ error: 'El repositorio de tools es de sólo lectura (deploy por YAML)' }, 409)
    }
    const name = c.req.param('name')
    const existing = await toolRepo.getByName(name)
    if (!existing) return c.json({ error: `No existe '${name}'` }, 404)

    await toolRepo.deleteByName(name)
    await reapply()
    return c.json({
      ok: true,
      ...(existing.kind === 'override'
        ? { note: 'La descripción original vuelve al reiniciar el proceso.' }
        : {}),
    })
  })

  return router
}
