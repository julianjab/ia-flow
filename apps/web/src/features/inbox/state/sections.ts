// En qué estado está cada sección de la bandeja, según qué pedido llegó: cada una pinta en cuanto
// llega SU dato, sin esperar a las demás. Puro, sin Vue ni red.
//
// - `decisions` (titular, Lo primero, Después), `epics` e `hygiene` salen de `/api/tasks` + el
//   dashboard (o, con un runner viejo, de `/api/inbox`).
// - `pipeline` sale de la capacidad de `/api/tasks`; si el dashboard la apaga, de la del runner.
// - `feed` sale del panel del dashboard (con las decisiones) o, si no lo define, del `feed` que
//   manda el runner en `/api/inbox`, que se pide en paralelo y puede llegar antes o después.

/** Cómo va un pedido: sin pedir, en vuelo, con dato, o falló sin dato que mostrar. */
export type Phase = 'idle' | 'loading' | 'ready' | 'error'

/** Lo que dibuja una sección: su esqueleto, su contenido, su error o nada. */
export type SectionState = 'loading' | 'ready' | 'error' | 'none'

export interface SectionInput {
  /** `/api/tasks` (o el inbox de un runner viejo): las decisiones. */
  decisions: Phase
  /** `/api/inbox` como respaldo de lo que el dashboard no define. */
  runner: Phase
  /** Los paneles del dashboard; `null` con un runner viejo (todo sale de `/api/inbox`). */
  panels: { feed: boolean; pipeline: boolean } | null
}

export interface Sections {
  decisions: SectionState
  epics: SectionState
  hygiene: SectionState
  pipeline: SectionState
  feed: SectionState
}

const fromPhase = (phase: Phase): SectionState => (phase === 'idle' ? 'loading' : phase)

export function sectionsOf({ decisions, runner, panels }: SectionInput): Sections {
  const main = fromPhase(decisions)
  // Sin la capacidad del dashboard se cuenta con la del runner; si ésa falla, con las tarjetas.
  const pipeline =
    main !== 'ready'
      ? main
      : panels && !panels.pipeline && runner === 'loading'
        ? 'loading'
        : 'ready'
  const feed: SectionState =
    panels?.feed === true
      ? main
      : runner === 'idle'
        ? main === 'ready'
          ? 'none'
          : 'loading'
        : runner
  return { decisions: main, epics: main, hygiene: main, pipeline, feed }
}
