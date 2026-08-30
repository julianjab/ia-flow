import type { Rule } from '@ia-flow/shared'

// Plantillas de regla.
//
// El formulario completo pide `on[]`, `when[]` con operadores, `do[]` y
// `exclusive`. Eso es el ESQUEMA, no la tarea: quien va a escribir una regla
// piensa "quiero que corra el reviewer cuando se abre un PR", no "quiero un
// array de tipos de evento".
//
// Una plantilla pre-llena la FORMA y deja exactamente los campos que varían.
// No pre-llena valores inventados —ningún `agentId` de ejemplo— porque un valor
// puesto por defecto que nadie eligió es peor que un campo vacío: se guarda sin
// que nadie lo mire.

export interface RuleTemplate {
  key: string
  label: string
  /** Qué queda por completar. Es lo que se muestra bajo el nombre. */
  hint: string
  build(): Partial<Rule>
}

export const RULE_TEMPLATES: RuleTemplate[] = [
  {
    key: 'status',
    label: 'Correr un agente al entrar a un status',
    hint: 'Elegí el status y el agente',
    build: () => ({
      on: ['issue.status_changed'],
      when: [{ field: 'status', op: '=', value: '' }],
      do: [{ action: 'agent', agentId: '' }],
      // Exclusiva: la forma del pipeline por etapas es "una etapa, un agente".
      // Sin esto, dos reglas sobre el mismo status corren las DOS — que es el
      // cambio de semántica más fácil de no ver al migrar desde el modelo
      // viejo, donde `selectAgent` corría sólo la primera.
      exclusive: true,
    }),
  },
  {
    key: 'pr',
    label: 'Reaccionar a un pull request',
    hint: 'Elegí el agente que lo revisa',
    build: () => ({
      on: ['pr.opened', 'pr.synchronize'],
      do: [{ action: 'agent', agentId: '' }],
    }),
  },
  {
    key: 'ci',
    label: 'Reaccionar al resultado del CI',
    hint: 'Ya filtra por CI verde — cambiá el valor para reaccionar a los rojos',
    build: () => ({
      on: ['ci.finished'],
      when: [{ field: 'conclusion', op: '=', value: 'success' }],
      do: [{ action: 'agent', agentId: '' }],
    }),
  },
  {
    key: 'http',
    label: 'Llamar a una API',
    hint: 'Elegí el evento y la URL',
    build: () => ({
      on: [],
      do: [{ action: 'http', method: 'POST', url: '' }],
    }),
  },
  {
    key: 'cron',
    label: 'Correr algo cada tanto',
    hint: 'Todos los lunes a las 9 — cambiá el cron si querés otra cadencia',
    build: () => ({
      on: ['schedule.tick'],
      schedule: '0 9 * * 1',
      do: [{ action: 'agent', agentId: '' }],
    }),
  },
  {
    key: 'blank',
    label: 'En blanco',
    hint: 'Todos los campos vacíos',
    build: () => ({}),
  },
]

/** El evento que se repite: el scan lo emite por CADA item, en CADA ciclo. */
const RECURRING_EVENT = 'issue.scanned'

/**
 * Una regla sobre `issue.scanned` sin ninguna condición vuelve a matchear al
 * mismo issue en el próximo ciclo de scan, para siempre.
 *
 * Es el mismo pozo que el "filtro 0" de la activación vieja, y sigue sin dar
 * error en ningún lado: la regla se guarda bien, corre bien, y re-dispara sobre
 * el issue que ella misma acaba de mover. Avisarlo al guardar es el único
 * momento en que alguien lo puede ver antes de que pase.
 */
export function recurringRuleWarning(rule: {
  on?: string[]
  when?: unknown
  whenText?: string | null
  schedule?: string | null
}): string | null {
  if (!(rule.on ?? []).includes(RECURRING_EVENT)) return null
  const hasConds = Array.isArray(rule.when) && rule.when.length > 0
  if (hasConds || rule.whenText?.trim()) return null
  return (
    `Esta regla escucha ${RECURRING_EVENT} sin ninguna condición: el scan lo emite por cada ` +
    'issue en cada ciclo, así que va a re-dispararse sobre el mismo issue indefinidamente. ' +
    'Agregá una condición (por ejemplo el status) para acotarla.'
  )
}
