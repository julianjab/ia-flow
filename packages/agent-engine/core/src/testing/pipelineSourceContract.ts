import { describe, expect, it } from 'vitest'
import { Engine } from '../engine/Engine.js'
import type { PipelineSource } from '../engine/PipelineSource.js'
import type { DomainEvent } from '../events/DomainEvent.js'
import { EventBus } from '../events/EventBus.js'

/** Un caso armado por quien prueba su fuente: la fuente, y un evento que sí la hace correr. */
export interface PipelineSourceFixture {
  source: PipelineSource
  /** Un evento que al menos una pipeline de la fuente acepta. */
  matching: DomainEvent<any>
  /** Los ids de las pipelines que corren para `matching`, en el orden de `select`. */
  expected: string[]
  /** Opcional: un evento que ninguna pipeline acepta. */
  nonMatching?: DomainEvent<any>
}

export type PipelineSourceFactory = () => PipelineSourceFixture | Promise<PipelineSourceFixture>

/**
 * Lo que cualquier `PipelineSource` tiene que cumplir para que el `Engine` la despache: un roster
 * de pipelines con ids únicos (por fuente), leído en vivo en cada `list()`, y un filtro propio
 * (`explainMismatch`) que el engine respeta antes que el de cada pipeline.
 */
export function pipelineSourceContract(name: string, makeFixture: PipelineSourceFactory): void {
  describe(`PipelineSource contract: ${name}`, () => {
    it('lists pipelines with unique ids', async () => {
      const { source } = await makeFixture()
      const ids = (await source.list()).map((pipeline) => pipeline.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('lists the same roster on every call', async () => {
      const { source } = await makeFixture()
      const first = (await source.list()).map((pipeline) => pipeline.id)
      const second = (await source.list()).map((pipeline) => pipeline.id)
      expect(second).toEqual(first)
    })

    it('lets through the event it is built for', async () => {
      const { source, matching } = await makeFixture()
      expect(source.explainMismatch?.(matching)).toBeUndefined()
    })

    it('an Engine selects its pipelines for a matching event', async () => {
      const { source, matching, expected } = await makeFixture()
      const engine = new Engine({ bus: new EventBus(), pipelines: source })
      expect((await engine.select(matching)).map((pipeline) => pipeline.id)).toEqual(expected)
    })

    it('an Engine selects nothing for an event none of its pipelines accepts', async () => {
      const { source, nonMatching } = await makeFixture()
      if (!nonMatching) return
      const engine = new Engine({ bus: new EventBus(), pipelines: source })
      expect(await engine.select(nonMatching)).toEqual([])
    })
  })
}
