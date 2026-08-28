import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { deferredStream, rollingFileStream } from './logger-sinks.js'

/** Un destino en memoria, para mirar qué llegó y en qué orden. */
function sink(): NodeJS.WritableStream & { lines: string[] } {
  const lines: string[] = []
  const s = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk))
      cb()
    },
  }) as unknown as NodeJS.WritableStream & { lines: string[] }
  s.lines = lines
  return s
}

const tick = () => new Promise((r) => setTimeout(r, 10))
// pino-roll abre el archivo de forma asíncrona y SonicBoom flushea a su
// ritmo: el sink de archivo necesita más aire que un destino en memoria.
const settle = () => new Promise((r) => setTimeout(r, 250))

describe('deferredStream', () => {
  test('vuelca al destino las líneas escritas antes de que abriera', async () => {
    const target = sink()
    let open!: () => void
    const stream = deferredStream(
      () =>
        new Promise((resolve) => {
          open = () => resolve(target)
        }),
      () => {},
    )

    stream.write('uno\n')
    stream.write('dos\n')
    expect(target.lines).toEqual([])

    open()
    await tick()
    expect(target.lines).toEqual(['uno\n', 'dos\n'])
  })

  test('las escrituras posteriores van derecho al destino', async () => {
    const target = sink()
    const stream = deferredStream(
      async () => target,
      () => {},
    )
    await tick()

    stream.write('tarde\n')
    expect(target.lines).toEqual(['tarde\n'])
  })

  test('un fallo al abrir apaga el sink sin tirar', async () => {
    const errors: unknown[] = []
    const stream = deferredStream(
      async () => {
        throw new Error('sin permisos')
      },
      (e) => errors.push(e),
    )

    stream.write('se pierde\n')
    await tick()

    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain('sin permisos')
    // La clave: escribir después NO tira — el resto de los sinks sigue vivo.
    expect(() => stream.write('tampoco llega\n')).not.toThrow()
  })

  test('un error del destino ya abierto apaga el sink en vez de tirar', async () => {
    const target = sink()
    const errors: unknown[] = []
    const stream = deferredStream(
      async () => target,
      (e) => errors.push(e),
    )
    await tick()

    target.emit('error', new Error('disco lleno'))
    expect(errors).toHaveLength(1)
    expect(() => stream.write('post mortem\n')).not.toThrow()
  })

  test('el buffer de arranque está acotado — descarta líneas, no memoria', async () => {
    const target = sink()
    let open!: () => void
    const stream = deferredStream(
      () =>
        new Promise((resolve) => {
          open = () => resolve(target)
        }),
      () => {},
    )

    for (let i = 0; i < 1_200; i++) stream.write(`l${i}\n`)
    open()
    await tick()

    expect(target.lines).toHaveLength(1_000)
    // Se conservan las MÁS NUEVAS: lo viejo es lo que se tira.
    expect(target.lines[target.lines.length - 1]).toBe('l1199\n')
  })

  test('siempre llama al callback — un cb() perdido congela el multistream', async () => {
    const stream = deferredStream(
      async () => {
        throw new Error('muerto')
      },
      () => {},
    )
    await tick()

    let called = false
    stream.write('x\n', () => {
      called = true
    })
    await tick()
    expect(called).toBe(true)
  })
})

describe('rollingFileStream', () => {
  const dirs: string[] = []
  afterEach(() => dirs.splice(0))

  test('escribe NDJSON en daemon.<n>.log, que es lo que la UI lee', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ia-flow-logs-'))
    dirs.push(dir)
    const stream = rollingFileStream({ file: join(dir, 'daemon'), size: '50m', count: 4 }, () => {})

    stream.write('{"level":30,"msg":"hola"}\n')
    await settle()

    const files = readdirSync(dir)
    expect(files).toContain('daemon.1.log')
    expect(readFileSync(join(dir, 'daemon.1.log'), 'utf8')).toContain('"msg":"hola"')
  })

  test('un directorio imposible apaga el sink en vez de tumbar el proceso', async () => {
    const errors: unknown[] = []
    // `/dev/null` es un archivo: no se puede crear un directorio adentro.
    const stream = rollingFileStream(
      { file: '/dev/null/nope/daemon', size: '50m', count: 4 },
      (e) => errors.push(e),
    )
    stream.write('{"msg":"se pierde"}\n')
    await settle()

    expect(errors).toHaveLength(1)
    expect(() => stream.write('{"msg":"y sigue vivo"}\n')).not.toThrow()
  })
})
