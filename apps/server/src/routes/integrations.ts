import type { IntegrationsStatus } from '@ia-flow/shared'
import { Hono } from 'hono'
import { slack } from '../composition/container.js'

// GET /api/integrations — qué sistemas externos puede usar este proceso.
//
// Existe para que la web no dibuje controles que no pueden funcionar: los
// campos de review de Slack se ocultan cuando no hay token, en vez de mostrar
// pickers que siempre vuelven vacíos. Es lo mismo que ya hace
// `relevantConfigVars()` para las variables de entorno — el proceso declara qué
// tiene sentido en él— pero del lado de las features, no de la config.
//
// Se calcula POR REQUEST: el token se pega desde Configuración sin reiniciar,
// así que un estado congelado al importar dejaría la UI escondida hasta el
// próximo boot.
export function createIntegrationsRouter() {
  const app = new Hono()

  app.get('/', (c) => {
    const body: IntegrationsStatus = { slack: slack.status() }
    return c.json(body)
  })

  return app
}
