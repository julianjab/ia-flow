import { describe, expect, it } from 'bun:test'
import { SYSTEM_COMMENT_MARKER, isCommentByAgent, selectCommentWindow } from '../comment-window.js'

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
