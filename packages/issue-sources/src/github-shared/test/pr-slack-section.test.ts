import { describe, expect, it } from 'bun:test'
import { extractSlackThreadUrl, upsertSlackSection } from '../pr-slack-section.js'

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
