// Re-exporta el port canónico desde @ia-flow/rules, mismo patrón que
// IBroadcast. El contrato no puede vivir acá: lo implementan y lo consumen
// paquetes (`issue-sources` publica, `agent-engine` maneja) que no pueden
// importar de la app.
export type { EventHandler, EventOutcome, IEventBus } from '@ia-flow/rules'
