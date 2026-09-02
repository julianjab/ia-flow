import { describe, expect, it } from 'bun:test'
import type { RenderableComment } from '../comment-window.js'
import {
  SYSTEM_COMMENT_MARKER,
  isCommentByAgent,
  renderConversationWindow,
  selectCommentWindow,
} from '../comment-window.js'

/** Comentario escrito por un agente: encabezado `# <id>` + marker de postComment. */
function byAgent(id: string, headline?: string, body = 'cuerpo'): { body: string } {
  const header = headline ? `# ${id} · ${headline}` : `# ${id}`
  return { body: `${header}\n\n${body}\n\n${SYSTEM_COMMENT_MARKER}` }
}

function byHuman(body: string): { body: string } {
  return { body }
}

describe('isCommentByAgent', () => {
  it('reconoce el comentario de cierre de un agente', () => {
    expect(isCommentByAgent(byAgent('implementer').body, 'implementer')).toBe(true)
  })

  it('reconoce los headlines (❌ falló, 🟡 pausado, texto de add_task_comment)', () => {
    for (const h of ['❌ falló', '🟡 pausado', 'Handoff E2E Tester -> Build']) {
      expect(isCommentByAgent(byAgent('e2e-tester', h).body, 'e2e-tester')).toBe(true)
    }
  })

  it('no confunde a un agente con otro cuyo id lo tiene como prefijo', () => {
    // Sin match exacto del primer segmento, `e2e-tester` se reconocería en los
    // comentarios de `e2e-tester-mac` y cortaría la ventana en el lugar
    // equivocado.
    expect(isCommentByAgent(byAgent('e2e-tester-mac').body, 'e2e-tester')).toBe(false)
    expect(isCommentByAgent(byAgent('e2e-tester-mac').body, 'e2e-tester-mac')).toBe(true)
  })

  it('un comentario humano que arranca con "# implementer" no cuenta — le falta el marker', () => {
    // El marker es lo que distingue "lo escribió el engine" de "un humano
    // escribió algo que se le parece".
    expect(isCommentByAgent('# implementer\n\nojo con esto', 'implementer')).toBe(false)
  })

  it('el comentario de OTRO agente no es propio', () => {
    expect(isCommentByAgent(byAgent('ci-watcher', '❌ falló').body, 'implementer')).toBe(false)
  })
})

describe('selectCommentWindow', () => {
  it('devuelve lo posterior al último comentario propio', () => {
    // El caso real que motivó esto (issue #1251): el implementer despierta
    // porque el e2e falló, y necesita ver el handoff — no sus propios
    // resúmenes de hace tres días.
    const comments = [
      byAgent('implementer', undefined, 'corrida vieja'),
      byAgent('ci-watcher', '❌ falló', 'CI rojo de hace 3 días'),
      byAgent('implementer', undefined, 'mi última corrida'),
      byAgent('ci-watcher', undefined, 'CI verde'),
      byAgent('e2e-tester', '❌ Handoff E2E -> Build', 'el fallback nunca ocurre'),
    ]
    const win = selectCommentWindow(comments, 'implementer')
    expect(win.map((c) => c.body.split('\n')[0])).toEqual([
      '# ci-watcher',
      '# e2e-tester · ❌ Handoff E2E -> Build',
    ])
  })

  it('sin comentario propio devuelve todo — el agente nunca corrió acá', () => {
    // Falla hacia la ventana ANCHA a propósito: de más cuesta tokens, de menos
    // cuesta que el agente no sepa por qué lo despertaron.
    const comments = [byAgent('refiner'), byHuman('feedback humano')]
    expect(selectCommentWindow(comments, 'implementer')).toEqual(comments)
  })

  it('el último comentario propio siendo el más nuevo deja la ventana vacía', () => {
    const comments = [byAgent('ci-watcher', '❌ falló'), byAgent('implementer')]
    expect(selectCommentWindow(comments, 'implementer')).toEqual([])
  })

  it('un comentario humano posterior a la corrida propia entra en la ventana', () => {
    const comments = [byAgent('implementer'), byHuman('cambiá el endpoint a /v2')]
    const win = selectCommentWindow(comments, 'implementer')
    expect(win).toHaveLength(1)
    expect(win[0].body).toBe('cambiá el endpoint a /v2')
  })

  it('corta en el ÚLTIMO propio, no en el primero', () => {
    const comments = [
      byAgent('implementer', undefined, 'run 1'),
      byHuman('feedback viejo, ya atendido en run 2'),
      byAgent('implementer', undefined, 'run 2'),
      byHuman('feedback nuevo'),
    ]
    const win = selectCommentWindow(comments, 'implementer')
    expect(win.map((c) => c.body)).toEqual(['feedback nuevo'])
  })

  it('una lista vacía devuelve vacío', () => {
    expect(selectCommentWindow([], 'implementer')).toEqual([])
  })

  it('no muta la lista de entrada', () => {
    const comments = [byAgent('implementer'), byHuman('x')]
    const copy = [...comments]
    selectCommentWindow(comments, 'implementer')
    expect(comments).toEqual(copy)
  })
})

function renderable(over: Partial<RenderableComment>): RenderableComment {
  return { body: 'cuerpo', created_at: '2026-08-30T10:00:00Z', ...over }
}

describe('renderConversationWindow', () => {
  it('sin comentarios nuevos devuelve vacío', () => {
    expect(renderConversationWindow([], 'implementer')).toBe('')
  })

  it('sin comentario propio, todo lo devuelto por selectCommentWindow entra', () => {
    const c = renderable({ body: 'primer feedback', origin: 'issue' })
    expect(renderConversationWindow([c], 'implementer')).toContain('primer feedback')
  })

  it('formatea un comentario de issue con fecha y autor', () => {
    const c = renderable({ body: 'cambiá el endpoint', author: 'julian', origin: 'issue' })
    const out = renderConversationWindow([c], 'implementer')
    expect(out).toBe('[2026-08-30T10:00:00Z · issue · julian]\ncambiá el endpoint')
  })

  it('formatea un comentario de PR con su número', () => {
    const c = renderable({ body: 'revisá el approach', origin: 'pr', prNumber: 482 })
    expect(renderConversationWindow([c], 'implementer')).toContain('PR #482')
  })

  it('formatea una review con path y línea', () => {
    const c = renderable({
      body: 'esto pierde el edge case',
      origin: 'pr-review',
      prNumber: 482,
      path: 'core/twilio.py',
      line: 88,
    })
    const out = renderConversationWindow([c], 'implementer')
    expect(out).toContain('PR #482 · review · core/twilio.py:88')
  })

  it('recorta a los últimos 10 comentarios', () => {
    const comments = Array.from({ length: 15 }, (_, i) => renderable({ body: `c${i}` }))
    const out = renderConversationWindow(comments, 'implementer')
    expect(out).not.toContain('c0\n')
    expect(out).toContain('c14')
    expect(out.split('\n\n')).toHaveLength(10)
  })

  it('recorta por el principio cuando el texto excede el tope de chars', () => {
    const long = renderable({ body: 'x'.repeat(5000) })
    const out = renderConversationWindow([long], 'implementer')
    expect(out.startsWith('…\n')).toBe(true)
    expect(out.endsWith('x')).toBe(true)
  })

  it('respeta el corte de selectCommentWindow contra el último comentario propio', () => {
    const comments = [
      renderable({ body: byAgent('implementer').body }),
      renderable({ body: 'feedback nuevo' }),
    ]
    const out = renderConversationWindow(comments, 'implementer')
    expect(out).toBe('[2026-08-30T10:00:00Z · issue]\nfeedback nuevo')
  })
})
