import { describe, expect, it } from 'vitest'
import { actionReadsPayload, extractPayloadFields, extractPayloadPaths } from '../action-payload.js'

// El contrato que se testea acá no es un regex: es que lo que se EXTRAE
// coincida con lo que los adapters INTERPOLAN. Cada caso de abajo está escrito
// contra un lugar concreto de `http-action.ts` / `script-action.ts`.

describe('extractPayloadPaths', () => {
  it('recorre url, headers y body de una acción http', () => {
    expect(
      extractPayloadPaths({
        action: 'http',
        url: 'https://ci/deploy/{{event.payload.branch}}',
        method: 'POST',
        headers: { 'x-run': '{{event.payload.runId}}' },
        body: { pr: '{{event.payload.pr.number}}', tags: ['{{event.payload.env}}'] },
      }),
    ).toEqual(['branch', 'runId', 'pr.number', 'env'])
  })

  it('recorre args y env de una acción script', () => {
    expect(
      extractPayloadPaths({
        action: 'script',
        runtime: 'bash',
        file: 'scripts/deploy.sh',
        args: ['{{event.payload.branch}}'],
        env: { TARGET: '{{event.payload.target}}' },
      }),
    ).toEqual(['branch', 'target'])
  })

  // Los adapters aceptan espacios adentro de las llaves; extraer sin ellos
  // marcaría como "no usado" un campo que sí se lee.
  it('tolera espacios, igual que el interpolate de los adapters', () => {
    expect(extractPayloadPaths({ url: '{{ event.payload.branch }}' })).toEqual(['branch'])
  })

  // `headers[k] = interpolate(raw)` — la clave NO pasa por el interpolate.
  it('no mira las claves, sólo los valores', () => {
    expect(extractPayloadPaths({ '{{event.payload.nope}}': 'fijo' })).toEqual([])
  })

  it('ignora lo que no es un placeholder de payload', () => {
    expect(extractPayloadPaths({ url: '{{event.scope.projectId}}/{{otra}}' })).toEqual([])
  })

  it('no repite un campo usado dos veces', () => {
    expect(extractPayloadPaths({ a: '{{event.payload.x}}', b: '{{event.payload.x}}' })).toEqual([
      'x',
    ])
  })
})

describe('extractPayloadFields', () => {
  // `{{event.payload.pr.number}}` no pide un parámetro llamado `pr.number`:
  // pide un `pr` con un `number` adentro. Las `properties` de un input_schema
  // son las claves de primer nivel.
  it('colapsa al primer segmento', () => {
    expect(
      extractPayloadFields({ a: '{{event.payload.pr.number}}', b: '{{event.payload.pr.url}}' }),
    ).toEqual(['pr'])
  })
})

describe('actionReadsPayload', () => {
  it('http y script interpolan; emit y agent no', () => {
    expect(actionReadsPayload('http')).toBe(true)
    expect(actionReadsPayload('script')).toBe(true)
    // `emit-action.ts` publica `config.payload` tal cual, sin interpolar.
    expect(actionReadsPayload('emit')).toBe(false)
    // `agent-action.ts` sólo lee `payload.item`, que una tool no produce.
    expect(actionReadsPayload('agent')).toBe(false)
  })
})
