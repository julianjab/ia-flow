import { EditableToolSchema } from '@ia-flow/shared'
import { getAllTools } from '@ia-flow/tools'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { actionRepo, projectRepo, toolRepo } from '../composition/container.js'
import { isBuiltInName } from '../composition/editable-tools.js'
import { reapplyEditableTools } from '../composition/reapply-tools.js'
import { createLogger } from '../logger.js'

const log = createLogger('tools-crud')

// CRUD de tools editables, con el MISMO criterio de ámbito que reglas, acciones
// y agentes: viaja por query y no se deduce del body.
//
// Lo que el ámbito decide acá es quién VE una tool y quién la puede editar. Lo
// que NO decide es el nombre: sigue siendo global (ver `ToolNameSchema`) porque
// `ProviderInput.tools` viaja como lista de nombres hasta un registry único del
// proceso. De ahí que la tabla tenga PK por `name` y que crear una tool con un
// nombre ya tomado en otro ámbito sea un 409 y no una segunda fila.

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

export function createToolsCrudRouter() {
  const router = new Hono()

  // GET /api/tools-crud?scope=global|projectId=X
  //
  // Tres listas y no una, porque lo editable es distinto en cada una y esa
  // diferencia ES la respuesta a "¿qué puedo tocar acá?":
  //
  //   editable   las de ESTE ámbito — se crean, se editan y se borran acá.
  //   inherited  las globales vistas desde un proyecto — se ven, no se tocan.
  //   builtIns   las del código. Su descripción se ajusta con un `override`,
  //              que es global siempre: `setToolDescription` pisa el registry
  //              del PROCESO, así que una override por proyecto sería una
  //              promesa que el runtime no puede cumplir.
  router.get('/', async (c) => {
    const s = resolveScope(c)
    if (!s.ok) return c.json({ error: s.error }, 400)

    const editable = await toolRepo.list(
      s.target === null ? { global: true } : { projectId: s.target },
    )
    const inherited = s.target === null ? [] : await toolRepo.list({ global: true })

    // Los overrides salen de las globales: son las únicas que existen.
    const overrides = new Map(
      [...editable, ...inherited]
        .filter((t) => t.kind === 'override')
        .map((t) => [t.name, t.description]),
    )
    // Una built-in tapada por una tool definida —de este ámbito o heredada— ya
    // no es la built-in: listarla igual mostraría dos filas para un solo nombre.
    const definedNames = new Set(
      [...editable, ...inherited].filter((t) => t.kind === 'defined').map((t) => t.name),
    )

    return c.json({
      editable,
      inherited,
      builtIns: getAllTools()
        .filter((t) => !definedNames.has(t.name))
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
    const s = resolveScope(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    if (toolRepo.isReadOnly()) {
      return c.json({ error: 'El repositorio de tools es de sólo lectura (deploy por YAML)' }, 409)
    }

    const name = c.req.param('name')
    const body = (await c.req.json()) as Record<string, unknown>
    const parsed = EditableToolSchema.safeParse({
      ...body,
      name,
      // El ámbito sale de la query, nunca del body: sin esto una escritura
      // desde un proyecto podría mandar `projectId: null` y promover su tool a
      // global —o pisar una global— sin que nada lo diga.
      projectId: body.kind === 'override' ? null : s.target,
    })
    if (!parsed.success) {
      return c.json({ error: 'Payload inválido', issues: parsed.error.issues }, 400)
    }
    const tool = parsed.data

    // Una override sólo tiene sentido en General: `setToolDescription` pisa el
    // registry del proceso, uno solo para todos los proyectos.
    if (tool.kind === 'override' && s.target !== null) {
      return c.json(
        {
          error:
            'La descripción de una tool built-in es global: se ajusta desde General, no desde un proyecto',
        },
        409,
      )
    }

    // El nombre es global, así que un choque NO se resuelve por ámbito: la fila
    // existente manda. Sin esto, el `ON CONFLICT DO UPDATE` del repo le movía
    // el `project_id` a la tool de otro ámbito y se la robaba en silencio.
    const existing = await toolRepo.getByName(name)
    if (existing && (existing.projectId ?? null) !== s.target) {
      return c.json(
        {
          error:
            existing.projectId == null
              ? `'${name}' es una tool global: para modificarla, editala desde General`
              : `'${name}' ya existe en el proyecto '${existing.projectId}' — el nombre de una tool es único en todo el daemon`,
        },
        409,
      )
    }

    if (tool.kind === 'defined') {
      // Tapar una built-in cambiaría en silencio lo que hace un agente que la
      // declara — el modo de falla más caro de esta feature.
      if (isBuiltInName(name) && existing?.kind !== 'defined') {
        return c.json(
          {
            error: `'${name}' es una tool built-in: no se puede reemplazar, sólo ajustar su descripción (kind: override)`,
          },
          409,
        )
      }
      const action = await actionRepo.getById(tool.actionId)
      if (!action) {
        return c.json({ error: `La acción '${tool.actionId}' no existe` }, 400)
      }
      // El ámbito de la tool no puede ser más ancho NI ajeno al de lo que
      // ejecuta. Una global que corre una acción de proyecto sería visible
      // desde todos lados y ejecutable desde uno solo; una de A que corre una
      // acción de B le daría a los agentes de A el Slack, el GitHub y el repo
      // de B. Una acción global la puede ejecutar cualquiera — es lo que
      // significa ser global.
      if (action.projectId != null && action.projectId !== s.target) {
        return c.json(
          {
            error:
              s.target === null
                ? `La acción '${tool.actionId}' es del proyecto '${action.projectId}': una tool global no puede ejecutarla`
                : `La acción '${tool.actionId}' es del proyecto '${action.projectId}', no de '${s.target}'`,
          },
          400,
        )
      }
    } else if (!isBuiltInName(name)) {
      // Una override sobre algo que no existe no ajusta nada, y guardarla haría
      // creer que sí.
      return c.json({ error: `No hay ninguna tool built-in llamada '${name}'` }, 404)
    }

    const saved = await toolRepo.upsert(tool)
    await reapplyEditableTools()
    log.info({ name, kind: tool.kind, projectId: s.target }, 'Tool editable guardada')
    return c.json({ tool: saved })
  })

  // DELETE — para una `override`, revertir a la descripción del código.
  //
  // El revert NO se puede hacer en caliente: la built-in ya tiene su
  // descripción pisada en el registry del proceso, y el texto original vive
  // sólo en el código. Se avisa explícitamente en vez de fingir que volvió.
  router.delete('/:name', async (c) => {
    const s = resolveScope(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    if (toolRepo.isReadOnly()) {
      return c.json({ error: 'El repositorio de tools es de sólo lectura (deploy por YAML)' }, 409)
    }
    const name = c.req.param('name')
    const existing = await toolRepo.getByName(name)
    if (!existing) return c.json({ error: `No existe '${name}'` }, 404)
    if ((existing.projectId ?? null) !== s.target) {
      return c.json(
        {
          error:
            existing.projectId == null
              ? `'${name}' es una tool global: para borrarla, hacelo desde General`
              : `'${name}' es del proyecto '${existing.projectId}'`,
        },
        409,
      )
    }

    await toolRepo.deleteByName(name)
    await reapplyEditableTools()
    return c.json({
      ok: true,
      ...(existing.kind === 'override'
        ? { note: 'La descripción original vuelve al reiniciar el proceso.' }
        : {}),
    })
  })

  return router
}
