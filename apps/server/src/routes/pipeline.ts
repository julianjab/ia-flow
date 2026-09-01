import { Hono } from 'hono'
import { getPipelineUseCase } from '../composition/container.js'
import { createLogger } from '../logger.js'

const log = createLogger('pipeline')

export function createPipelineRouter() {
  const router = new Hono()

  // GET /api/pipeline?projectId=…
  //
  // Sin `projectId` devuelve el ámbito GLOBAL: sólo las reglas globales y los
  // runs que no declaran proyecto. No es "todos los proyectos" — eso mezclaría
  // reglas que nunca se ven entre sí y haría ilegible la pantalla.
  router.get('/', async (c) => {
    const projectId = c.req.query('projectId') || undefined
    try {
      return c.json(await getPipelineUseCase.execute(projectId))
    } catch (err) {
      log.error({ err, projectId }, 'No se pudo armar el pipeline')
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  return router
}
