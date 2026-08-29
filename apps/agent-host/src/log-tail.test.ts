import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCAN_BYTES, matchLine, readLogTail, tailFrom } from './log-tail.js'

function line(msg: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    level: 30,
    time: '2026-08-24T22:00:00.000Z',
    scope: 'agent-host',
    msg,
    ...extra,
  })
}

describe('matchLine', () => {
  it('sin filtro pasa todo — no filtrar no es resultado vacío', () => {
    expect(matchLine('', 'lo que sea')).toBe(true)
    expect(matchLine('   ', '')).toBe(true)
  })

  it('ignora mayúsculas y acentos', () => {
    expect(matchLine('SESION', 'la sesión murió')).toBe(true)
  })

  it('cada término acota en vez de ampliar', () => {
    expect(matchLine('run tmux', 'run de tmux terminado')).toBe(true)
    expect(matchLine('run iterm', 'run de tmux terminado')).toBe(false)
  })

  // La mitad de las búsquedas son por un id que sólo vive en los extras.
  it('matchea contra la línea cruda, extras incluidos', () => {
    expect(matchLine('t-42', line('run listo', { taskId: 't-42' }))).toBe(true)
  })

  // En el archivo el nivel es un número: sin esto, "error" —lo primero que
  // alguien tipea— no encontraba un solo error.
  it('un nombre de nivel matchea el número que hay en la línea', () => {
    const boom = JSON.stringify({ level: 50, msg: 'provider explotó' })
    expect(matchLine('error', boom)).toBe(true)
    expect(matchLine('warn', boom)).toBe(false)
    expect(matchLine('error explot', boom)).toBe(true)
  })

  it('el nombre del nivel no se confunde con el texto del mensaje', () => {
    const info = JSON.stringify({ level: 30, msg: 'sin novedad' })
    expect(matchLine('error', info)).toBe(false)
  })
})

describe('tailFrom', () => {
  const text = [line('uno'), line('dos'), line('tres')].join('\n')

  it('devuelve las últimas N en orden cronológico', () => {
    expect(tailFrom(text, 2).map((l) => l.msg)).toEqual(['dos', 'tres'])
  })

  it('parsea nivel, scope y extras', () => {
    const [entry] = tailFrom(line('run', { taskId: 't-1' }), 1)
    expect(entry?.level).toBe(30)
    expect(entry?.scope).toBe('agent-host')
    expect(entry?.msg).toBe('run')
    expect(entry?.extras).toEqual({ taskId: 't-1' })
  })

  // Lo que motiva que el filtro corra del lado del server: buscar sobre las
  // últimas N ya recortadas no encontraría nada más viejo que esa página.
  it('el filtro mira más atrás que el limit', () => {
    const noisy = [line('viejo error grave'), ...Array.from({ length: 50 }, () => line('ruido'))]
    expect(tailFrom(noisy.join('\n'), 5, 'error').map((l) => l.msg)).toEqual(['viejo error grave'])
  })

  it('una línea que no es JSON se muestra cruda en vez de desaparecer', () => {
    const [entry] = tailFrom('esto no es json', 5)
    expect(entry?.raw).toBe('esto no es json')
    expect(entry?.msg).toBeUndefined()
  })

  it('ignora renglones vacíos', () => {
    expect(tailFrom('\n\n' + line('uno') + '\n\n', 5)).toHaveLength(1)
  })
})

describe('readLogTail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-log-'))

  it('sin archivo configurado no es un error — es un agent-host sin archivo', async () => {
    expect(await readLogTail({ file: null, limit: 10 })).toEqual({
      file: null,
      lines: [],
      truncated: false,
    })
  })

  it('un archivo que todavía no existe devuelve vacío, no explota', async () => {
    const file = join(dir, 'nunca-escrito.log')
    expect(await readLogTail({ file, limit: 10 })).toEqual({ file, lines: [], truncated: false })
  })

  it('lee el final del archivo y aplica el filtro', async () => {
    const file = join(dir, 'agent-host.log')
    await Bun.write(
      file,
      [line('arranque'), line('run falló', { taskId: 't-9' })].join('\n') + '\n',
    )
    const tail = await readLogTail({ file, limit: 10, query: 't-9' })
    expect(tail.lines.map((l) => l.msg)).toEqual(['run falló'])
    expect(tail.truncated).toBe(false)
  })

  // Un log de meses no entra en RAM: se mira una ventana y se avisa, en vez
  // de mentir un "no hay resultados".
  it('un archivo más grande que la ventana se reporta truncado', async () => {
    const file = join(dir, 'enorme.log')
    const padded = line('x'.repeat(1024))
    const repeats = Math.ceil(SCAN_BYTES / padded.length) + 10
    await Bun.write(file, Array.from({ length: repeats }, () => padded).join('\n'))
    const tail = await readLogTail({ file, limit: 3 })
    expect(tail.truncated).toBe(true)
    expect(tail.lines).toHaveLength(3)
    // La primera línea de la ventana viene cortada al medio; no se muestra.
    expect(tail.lines.every((l) => l.msg !== undefined)).toBe(true)
  })
})
