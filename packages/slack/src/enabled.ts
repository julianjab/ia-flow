// ¿Este proceso tiene Slack?
//
// **La credencial es el interruptor.** No hay un `IA_FLOW_SLACK_ENABLED`
// aparte: un flag que se puede contradecir con el token (prendido sin token,
// apagado con token) agrega un estado inválido que alguien tiene que
// diagnosticar, y la respuesta honesta ya la da la credencial — sin
// `SLACK_BOT_TOKEN` no hay nada que este paquete pueda hacer.
//
// Son DOS interruptores y no uno porque son dos capacidades independientes:
// se puede pedir review sin recibir mensajes (lo normal), y en un deploy que
// sólo escucha la Events API sobra el bot token. Cada uno declara su falta.
//
// **Se leen por uso, nunca se capturan.** El operador pega el token en
// Configuración y eso escribe la fila de SQLite que `envRepo.loadIntoProcess()`
// vuelca a `Bun.env` — que corre DESPUÉS de que el composition root se evalúa.
// Un booleano calculado al importar dejaría Slack apagado hasta reiniciar.

/** El token del bot: `SLACK_BOT_TOKEN` (xoxb-…). Lo que habilita el cliente
 *  Web API — las tools, el directorio y el pedido de review. */
export function slackBotToken(): string | undefined {
  const raw = Bun.env.SLACK_BOT_TOKEN?.trim()
  return raw ? raw : undefined
}

/** El secreto que firma los deliveries: `SLACK_SIGNING_SECRET`. Lo que
 *  habilita la Events API entrante. */
export function slackSigningSecret(): string | undefined {
  const raw = Bun.env.SLACK_SIGNING_SECRET?.trim()
  return raw ? raw : undefined
}

export function isSlackEnabled(): boolean {
  return slackBotToken() !== undefined
}

export function isSlackWebhookEnabled(): boolean {
  return slackSigningSecret() !== undefined
}

/** Por qué está apagado, en texto para el operador. `undefined` = está
 *  prendido. Devolver el motivo es lo que convierte un picker vacío o un 503
 *  en algo accionable sin leer código. */
export function slackDisabledReason(): string | undefined {
  return isSlackEnabled() ? undefined : 'SLACK_BOT_TOKEN no está configurado'
}

export function slackWebhookDisabledReason(): string | undefined {
  return isSlackWebhookEnabled() ? undefined : 'SLACK_SIGNING_SECRET no está configurado'
}

/** El estado que se publica por HTTP (`GET /api/integrations`) para que la web
 *  no ofrezca controles que no pueden funcionar. */
export interface SlackStatus {
  enabled: boolean
  webhook: boolean
  reason?: string
  webhookReason?: string
}

export function slackStatus(): SlackStatus {
  const reason = slackDisabledReason()
  const webhookReason = slackWebhookDisabledReason()
  return {
    enabled: !reason,
    webhook: !webhookReason,
    ...(reason ? { reason } : {}),
    ...(webhookReason ? { webhookReason } : {}),
  }
}
