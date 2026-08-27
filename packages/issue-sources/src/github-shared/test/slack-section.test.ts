import { describe, expect, it } from 'bun:test'
import {
  extractSlackThreadUrl,
  preserveSlackSection,
  stripSlackSection,
  upsertSlackSection,
} from '../slack-section.js'

const URL_A = 'https://acme.slack.com/archives/C1/p1699999999123456'
const URL_B = 'https://acme.slack.com/archives/C1/p1700000000000000'

describe('upsertSlackSection', () => {
  it('agrega la sección al final, conservando el cuerpo', () => {
    const out = upsertSlackSection('Descripción del PR.', URL_A)
    expect(out.startsWith('Descripción del PR.')).toBe(true)
    expect(out).toContain('## Slack')
    expect(out).toContain(URL_A)
  })

  it('sobre un body vacío escribe sólo la sección', () => {
    expect(upsertSlackSection('', URL_A)).toContain('## Slack')
  })

  // El segundo pedido no debe dejar dos secciones: es upsert, no append.
  it('reemplaza el bloque en vez de acumular', () => {
    const once = upsertSlackSection('body', URL_A)
    const twice = upsertSlackSection(once, URL_B)
    expect(twice.match(/## Slack/g)).toHaveLength(1)
    expect(twice).toContain(URL_B)
    expect(twice).not.toContain(URL_A)
    expect(twice.startsWith('body')).toBe(true)
  })

  it('es idempotente con el mismo link', () => {
    const once = upsertSlackSection('body', URL_A)
    expect(upsertSlackSection(once, URL_A)).toBe(once)
  })
})

describe('extractSlackThreadUrl', () => {
  it('devuelve el link que escribió upsertSlackSection', () => {
    expect(extractSlackThreadUrl(upsertSlackSection('body', URL_A))).toBe(URL_A)
  })

  it('undefined cuando no hay bloque', () => {
    expect(extractSlackThreadUrl('body sin nada')).toBeUndefined()
    expect(extractSlackThreadUrl('')).toBeUndefined()
    expect(extractSlackThreadUrl(undefined)).toBeUndefined()
  })

  // Un `## Slack` escrito por un humano no es nuestro bloque: buscarlo por
  // heading haría que el upsert le pise su sección.
  it('ignora un heading "## Slack" que no lleve el marker', () => {
    expect(extractSlackThreadUrl('## Slack\n\nhttps://slack.com/algo')).toBeUndefined()
  })
})

describe('stripSlackSection', () => {
  it('saca el bloque y deja el resto intacto', () => {
    expect(stripSlackSection(upsertSlackSection('body\n\n## PRD', URL_A))).toBe('body\n\n## PRD')
  })

  it('un body sin bloque sólo pierde el espacio final', () => {
    expect(stripSlackSection('body\n')).toBe('body')
    expect(stripSlackSection(undefined)).toBe('')
  })
})

describe('preserveSlackSection', () => {
  // El caso que motiva el helper: el refiner reescribe el PRD entero y el link
  // del hilo, que vive en el mismo body, no puede desaparecer con él.
  it('re-adjunta el bloque del body viejo cuando el nuevo no trae ninguno', () => {
    const previous = upsertSlackSection('PRD viejo', URL_A)
    const merged = preserveSlackSection(previous, 'PRD nuevo')
    expect(merged.startsWith('PRD nuevo')).toBe(true)
    expect(extractSlackThreadUrl(merged)).toBe(URL_A)
    expect(merged).not.toContain('PRD viejo')
  })

  it('gana el bloque del body nuevo: escribirlo explícitamente es decidirlo', () => {
    const merged = preserveSlackSection(
      upsertSlackSection('viejo', URL_A),
      upsertSlackSection('nuevo', URL_B),
    )
    expect(extractSlackThreadUrl(merged)).toBe(URL_B)
    expect(merged.match(/## Slack/g)).toHaveLength(1)
  })

  it('sin bloque en ninguno de los dos devuelve el nuevo tal cual', () => {
    expect(preserveSlackSection('viejo', 'nuevo')).toBe('nuevo')
    expect(preserveSlackSection(undefined, 'nuevo')).toBe('nuevo')
  })
})
