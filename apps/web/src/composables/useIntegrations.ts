import type { IntegrationsStatus } from '@ia-flow/shared'
import { IntegrationsStatusSchema } from '@ia-flow/shared'
import axios from 'axios'
import { readonly, ref } from 'vue'

// Qué integraciones opcionales tiene el server con el que estamos hablando.
//
// Existe para no ofrecer controles que no pueden funcionar: sin
// `SLACK_BOT_TOKEN` los pickers de canal y reviewers vuelven siempre vacíos y
// el pedido de review falla, y desde la UI eso parece un bug en vez de un
// token faltante.
//
// **Fail-OPEN.** Si el endpoint no contesta —un server viejo que todavía no lo
// tiene, un proxy caído— se asume todo prendido. Esconder la config de Slack
// por un request fallido sería una regresión visible y sin explicación; en el
// peor caso los campos aparecen y el server contesta 503 con el motivo, que es
// exactamente el estado anterior a este composable.
const OPTIMISTA: IntegrationsStatus = { slack: { enabled: true, webhook: true } }

const state = ref<IntegrationsStatus>(OPTIMISTA)

// Una sola llamada por sesión, compartida: el estado lo consultan la tarjeta de
// cada tarea, el editor de repos y los defaults del proyecto, y todos preguntan
// por lo mismo. No se refresca solo — cambiar un token es un acto deliberado
// del operador, que recarga.
let inFlight: Promise<void> | null = null

function load(): Promise<void> {
  if (!inFlight) {
    inFlight = axios
      .get('/api/integrations')
      .then(({ data }) => {
        state.value = IntegrationsStatusSchema.parse(data)
      })
      .catch(() => {
        state.value = OPTIMISTA
      })
  }
  return inFlight
}

export function useIntegrations() {
  void load()
  return { integrations: readonly(state) }
}

/** Para los tests: olvida la respuesta cacheada. */
export function resetIntegrations(): void {
  inFlight = null
  state.value = OPTIMISTA
}
