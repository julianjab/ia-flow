import { type ToolContext, getAllTools, getTool } from '@ia-flow/tools'
import { Hono } from 'hono'
import { repoRepo, toolRepo } from '../composition/container.js'
import { createLogger } from '../logger.js'
// Side-effect: importing @ia-flow/tools registers every built-in tool
// (fs, write, exec, workspace, task, github) into the process-wide registry.
// Las de Slack NO entran por acá: las registra `installSlack` y sólo cuando hay
// credencial, así que este catálogo no ofrece una tool que siempre falla.

const log = createLogger('tools-route')

// Exported for routes/mcp.ts — same execution context, different transport.
// `projectId` NO es decorativo: sin él, `projectRepos` sería el roster de TODOS
// los proyectos, y `transfer_task_repo` valida su destino contra ese array — un
// run async podría mover el issue a un repo de otro proyecto, incluido un repo
// "inbox" que sólo está declarado en otro lado. El camino async lo tiene a mano
// (`?project=` de la conexión MCP), así que se pasa.
export function buildToolContext(projectId?: string): ToolContext {
  const repos = projectId ? repoRepo.listByProject(projectId) : repoRepo.list()
  const repoPaths = Object.fromEntries(repos.filter((r) => r.path).map((r) => [r.name, r.path!]))
  // El roster va aparte de los paths: `repoPaths` deja afuera los repos sin
  // clone local, y hay tools (`transfer_task_repo`) que necesitan saber qué
  // repos declara el proyecto, no cuáles están bajados.
  return { repoPaths, projectRepos: repos.map((r) => r.name) }
}

export function createToolsRouter() {
  const app = new Hono()

  // GET /api/tools[?projectId=X | ?scope=global] — catálogo plano de tools
  // registradas. La UI las agrupa visualmente por dominio
  // (fs/task/workspace/github/slack/bash) del lado cliente; el server ya no
  // tiene un concepto de "categoría" — un agente simplemente declara qué
  // nombres de tool tiene en `tools[]`.
  //
  // El registry es UNO para todo el proceso —una tool definida de CUALQUIER
  // proyecto está registrada—, así que el ámbito se filtra acá contra la tabla:
  // sin esto el editor de un agente de A ofrecía las tools definidas de B, que
  // el agente puede nombrar pero cuya acción no le pertenece.
  //
  // Sin ámbito devuelve TODO, siguiendo la convención del repo (vacío = sin
  // restricción, ver `packages/rules/src/scope.ts`): este endpoint también es
  // el catálogo plano del registry, y acotarlo por default le sacaría tools a
  // consumidores que no tienen un ámbito que declarar.
  app.get('/', async (c) => {
    const projectId = c.req.query('projectId')
    const scoped = projectId != null || c.req.query('scope') === 'global'
    const foreign = scoped
      ? new Set(
          (await toolRepo.list())
            // Sólo las de OTRO proyecto. Las globales las ve todo el mundo —
            // son justamente las heredadas.
            .filter((t) => t.projectId != null && t.projectId !== projectId)
            .map((t) => t.name),
        )
      : new Set<string>()
    const tools = getAllTools()
      .filter((t) => !foreign.has(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
        aliases: t.aliases ?? [],
      }))
    return c.json(tools)
  })

  // POST /api/tools/:name — execute a tool by name
  // Used by async agents (tmux/iterm) to report results and trigger transitions.
  app.post('/:name', async (c) => {
    const name = c.req.param('name')
    const tool = getTool(name)
    if (!tool) return c.json({ error: `Tool '${name}' not found` }, 404)

    let input: unknown
    try {
      input = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    log.debug({ tool: name, input }, 'tool execute via HTTP')

    try {
      const result = await tool.execute(input, buildToolContext())
      return c.json({ result })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn({ tool: name, err: msg }, 'tool execute failed')
      return c.json({ error: msg }, 500)
    }
  })

  return app
}
