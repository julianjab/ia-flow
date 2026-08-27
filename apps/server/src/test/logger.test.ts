import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logMaxFiles, logMaxSize, otelStream, toOtelRecord } from '../logger.js'

const LOGGER_PATH = join(import.meta.dir, '..', 'logger.ts')

// logger.ts lee su env (IA_FLOW_LOG_DIR, OTEL_*) y construye el LoggerProvider
// UNA vez, al importarse. Como `bun test` corre todos los archivos del server
// en el mismo proceso, cualquier otra suite que importe el logger antes lo deja
// fijado — con el daemon.log real de la máquina, encima. Por eso los probes que
// necesitan un logger de verdad corren en un SUBPROCESO con su propio temp dir:
// es la única forma de que sean deterministas y de no ensuciar
// ~/.config/ia-flow/logs/daemon.log al correr los tests.
//
// Los dos casos puros (toOtelRecord y las guardas de otelStream) sí se prueban
// in-process: leen su env en cada llamada y no tocan estado del módulo.

interface ProbeResult {
  code: number
  stderr: string
  lines: Record<string, unknown>[]
}

async function runProbe(body: string, env: Record<string, string>): Promise<ProbeResult> {
  const dir = await mkdtemp(join(tmpdir(), 'ia-flow-logger-probe-'))
  const file = join(dir, 'probe.ts')
  await writeFile(
    file,
    [
      `import { createLogger, flushOtel, ingestRemoteLogEntry, initOtelSink } from ${JSON.stringify(LOGGER_PATH)}`,
      // Cualquier rechazo sin manejar del camino OTel tiene que ser visible: es
      // exactamente lo que el fail-open de Q5 promete que no pasa.
      `process.on('unhandledRejection', (err) => console.error('UNHANDLED_REJECTION', err))`,
      body,
      'await flushOtel()',
      // Margen para el worker de pino: sin esto la última línea puede no estar
      // en disco cuando el proceso termina.
      'await Bun.sleep(400)',
    ].join('\n'),
  )

  // Env explícito: heredar el del test dejaría entrar un OTEL_* del shell y
  // haría que el caso "sin endpoint" dejara de probar lo que dice probar.
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(Bun.env)) {
    if (k.startsWith('OTEL_')) continue
    if (typeof v === 'string') base[k] = v
  }

  const proc = Bun.spawn(['bun', 'run', file], {
    env: { ...base, IA_FLOW_LOG_DIR: dir, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])

  // `daemon.1.log`, no `daemon.log`: el sink rota por tamaño (pino-roll) y el
  // contador va en el nombre. Se resuelve el más nuevo igual que
  // resolveLogFile() en routes/server-logs.ts — si esto y aquello se
  // desincronizan, el que se rompe es el archivo que la UI lee.
  const rolled = readdirSync(dir)
    .map((name) => ({ name, n: Number(name.match(/^daemon\.(\d+)\.log$/)?.[1] ?? Number.NaN) }))
    .filter((f) => Number.isFinite(f.n))
    .sort((a, b) => b.n - a.n)[0]
  const logFile = join(dir, rolled?.name ?? 'daemon.log')
  const raw = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  const lines = raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)

  await rm(dir, { recursive: true, force: true })
  return { code, stderr, lines }
}

// El payload OTLP/JSON anida los valores en { stringValue } / { intValue } / …;
// estos dos helpers lo aplanan para poder afirmar sobre lo que llegó.
function anyValue(v: Record<string, unknown>): unknown {
  return Object.values(v)[0]
}

function resourceAttributes(payloads: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of payloads as OtlpPayload[]) {
    for (const rl of p.resourceLogs ?? []) {
      for (const a of rl.resource?.attributes ?? []) out[a.key] = anyValue(a.value)
    }
  }
  return out
}

function logBodies(payloads: unknown[]): string[] {
  const out: string[] = []
  for (const p of payloads as OtlpPayload[]) {
    for (const rl of p.resourceLogs ?? []) {
      for (const sl of rl.scopeLogs ?? []) {
        for (const r of sl.logRecords ?? []) out.push(String(anyValue(r.body)))
      }
    }
  }
  return out
}

interface OtlpPayload {
  resourceLogs?: {
    resource?: { attributes?: { key: string; value: Record<string, unknown> }[] }
    scopeLogs?: { logRecords?: { body: Record<string, unknown> }[] }[]
  }[]
}

// Puerto muerto a propósito: el sink se construye de verdad y el collector no
// existe. Es el probe de fail-open de Q5 del ADR.
const DEAD_ENDPOINT = 'http://127.0.0.1:9'

describe('createLogger', () => {
  it('escribe el shape que routes/server-logs.ts consume', async () => {
    const { code, lines } = await runProbe(
      `createLogger('shape-probe').info({ taskId: 'T-1' }, 'hello from the probe')`,
      {},
    )
    expect(code).toBe(0)
    const line = lines.find((l) => l.msg === 'hello from the probe')
    expect(line).toBeDefined()
    // Los tres campos que parseLine() exige para no descartar la línea…
    expect(line?.level).toBe(30)
    expect(typeof line?.time).toBe('string')
    // …más los que promueve a first-class y a extras.
    expect(line?.module).toBe('shape-probe')
    expect(typeof line?.pid).toBe('number')
    expect(line?.taskId).toBe('T-1')
  })

  it('no rompe ni deja unhandledRejection con el collector en un puerto muerto', async () => {
    const { code, stderr, lines } = await runProbe(
      `createLogger('dead-port').info('sigue escribiendo')`,
      { OTEL_EXPORTER_OTLP_ENDPOINT: DEAD_ENDPOINT },
    )
    // El proceso sobrevive, el archivo se escribe igual…
    expect(code).toBe(0)
    expect(lines.some((l) => l.msg === 'sigue escribiendo')).toBe(true)
    // …y ni un rechazo sin manejar ni ruido de reintentos del exporter.
    expect(stderr).not.toContain('UNHANDLED_REJECTION')
    expect(stderr).not.toContain('[otel]')
  })
})

describe('otelStream', () => {
  it('devuelve null sin OTEL_EXPORTER_OTLP_ENDPOINT', () => {
    const previous = Bun.env.OTEL_EXPORTER_OTLP_ENDPOINT
    Bun.env.OTEL_EXPORTER_OTLP_ENDPOINT = undefined
    try {
      // Sin endpoint no se construye ningún LoggerProvider; el spread
      // condicional del multistream deja el sink afuera y el logger igual existe.
      expect(otelStream()).toBeNull()
    } finally {
      Bun.env.OTEL_EXPORTER_OTLP_ENDPOINT = previous
    }
  })

  it('devuelve null con OTEL_SDK_DISABLED=true aunque haya endpoint', () => {
    const previousEndpoint = Bun.env.OTEL_EXPORTER_OTLP_ENDPOINT
    const previousDisabled = Bun.env.OTEL_SDK_DISABLED
    Bun.env.OTEL_EXPORTER_OTLP_ENDPOINT = DEAD_ENDPOINT
    Bun.env.OTEL_SDK_DISABLED = 'true'
    try {
      expect(otelStream()).toBeNull()
    } finally {
      Bun.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousEndpoint
      Bun.env.OTEL_SDK_DISABLED = previousDisabled
    }
  })

  it('el logger del módulo se construyó igual sin sink OTel', async () => {
    const { default: logger, createLogger } = await import('../logger.js')
    expect(typeof logger.info).toBe('function')
    expect(() => createLogger('sin-otel').debug('sigue vivo')).not.toThrow()
  })
})

describe('toOtelRecord', () => {
  it('mapea nivel, msg y el resto a atributos', () => {
    const record = toOtelRecord(
      JSON.stringify({ level: 50, time: '2026-01-01T00:00:00.000Z', msg: 'boom', module: 'x' }),
    )
    expect(record).not.toBeNull()
    expect(record?.body).toBe('boom')
    expect(record?.attributes.module).toBe('x')
    // time y level no viajan como atributos: son campos del LogRecord.
    expect(record?.attributes.time).toBeUndefined()
    expect(record?.attributes.level).toBeUndefined()
  })

  it('devuelve null ante un chunk ilegible en vez de tirar', () => {
    expect(toOtelRecord('no soy json')).toBeNull()
  })

  it('descarta el record marcado como ingerido', () => {
    expect(toOtelRecord(JSON.stringify({ level: 30, msg: 'x', __iaFlowIngested: true }))).toBeNull()
  })
})

describe('ingestRemoteLogEntry', () => {
  it('estampa la marca, y el sink OTel descarta la entrada ingerida', async () => {
    const { code, lines } = await runProbe(
      `ingestRemoteLogEntry({ level: 'info', module: 'daemon-b', msg: 'ingested plain', extras: { source: 'daemon-b' } })`,
      { OTEL_EXPORTER_OTLP_ENDPOINT: DEAD_ENDPOINT },
    )
    expect(code).toBe(0)
    const line = lines.find((l) => l.msg === 'ingested plain')
    // Sigue yendo al archivo NDJSON (y por lo tanto a la UI del receptor)…
    expect(line?.source).toBe('daemon-b')
    // …pero con la marca, así que el sink OTel no la re-exporta.
    expect(line?.__iaFlowIngested).toBe(true)
    expect(toOtelRecord(JSON.stringify(line))).toBeNull()
  })

  it('un POST con __iaFlowIngested:false no puede apagar la marca', async () => {
    // El extras llega crudo del body de POST /api/remote-logs; el orden del
    // merge object (spread primero, marca después) es lo que lo neutraliza.
    const { code, lines } = await runProbe(
      `ingestRemoteLogEntry({ level: 'info', module: 'daemon-hostil', msg: 'forcing the flag off', extras: { __iaFlowIngested: false } })`,
      { OTEL_EXPORTER_OTLP_ENDPOINT: DEAD_ENDPOINT },
    )
    expect(code).toBe(0)
    const line = lines.find((l) => l.msg === 'forcing the flag off')
    expect(line?.__iaFlowIngested).toBe(true)
    expect(toOtelRecord(JSON.stringify(line))).toBeNull()
  })
})

describe('initOtelSink', () => {
  it('arma el sink con el endpoint que llega DESPUÉS del import, y exporta al collector', async () => {
    // El caso de las tres env vars editables: `index.ts` importa el logger
    // mucho antes de llamar a `envRepo.loadIntoProcess()`, así que en el
    // module-init de logger.ts el endpoint guardado en SQLite todavía no está
    // en Bun.env. Sin el segundo intento, la config de la UI no haría nada.
    const payloads: unknown[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        payloads.push(await req.json())
        return new Response('{}', { headers: { 'content-type': 'application/json' } })
      },
    })

    try {
      const { code } = await runProbe(
        [
          `Bun.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:${server.port}'`,
          `if (!initOtelSink()) throw new Error('el sink no se montó')`,
          `createLogger('deferred').info({ taskId: 'T-9' }, 'after loadIntoProcess')`,
        ].join('\n'),
        { IA_FLOW_INSTANCE_ID: 'probe-instance' },
      )
      expect(code).toBe(0)

      const attributes = resourceAttributes(payloads)
      // Los cuatro resource attributes de Q3 del ADR.
      expect(attributes['service.name']).toBe('ia-flow-server')
      expect(attributes['service.instance.id']).toBe('probe-instance')
      expect(typeof attributes['service.version']).toBe('string')
      expect(attributes['deployment.environment.name']).toBe('development')
      expect(logBodies(payloads)).toContain('after loadIntoProcess')
    } finally {
      server.stop(true)
    }
  })
})

describe('config de rotación', () => {
  it('un limit.count inválido cae al default en vez de apagar el límite', () => {
    // El caso peligroso: `Number('banana')` es NaN, que PASA la validación de
    // pino-roll (`typeof NaN === 'number'`, `NaN <= 0` es false) y después
    // hace que `files.length > NaN` nunca sea true. Resultado: no se borra
    // ningún rotado y el techo de disco desaparece en silencio — justo el bug
    // que la rotación vino a arreglar.
    expect(logMaxFiles('banana')).toBe(4)
    expect(logMaxFiles(undefined)).toBe(4)
    expect(logMaxFiles('')).toBe(4)
    expect(logMaxFiles('0')).toBe(4)
    expect(logMaxFiles('-3')).toBe(4)
    // Un valor usable se respeta, entero.
    expect(logMaxFiles('10')).toBe(10)
    expect(logMaxFiles('2.7')).toBe(2)
  })

  it('un size inválido cae al default en vez de tirar en el worker', () => {
    // pino-roll hace throw si el size no matchea su regex, y eso pasa DENTRO
    // del worker del transport: se lleva puesto el logging entero del proceso.
    expect(logMaxSize('banana')).toBe('50m')
    expect(logMaxSize('50 m')).toBe('50m')
    expect(logMaxSize(undefined)).toBe('50m')
    expect(logMaxSize('')).toBe('50m')
    // Y los que la regex sola dejaría pasar: pino-roll decide si engancha la
    // rotación con `if (maxSize)`, así que un 0 —o el NaN de '.'— la apaga sin
    // decir nada. `=0` es además lo que alguien escribe queriendo "sin límite".
    expect(logMaxSize('0')).toBe('50m')
    expect(logMaxSize('0m')).toBe('50m')
    expect(logMaxSize('.')).toBe('50m')
    // Dos puntos: pino-roll lo parsea a NaN, que es falsy igual que el 0.
    expect(logMaxSize('1.2.3m')).toBe('50m')
    expect(logMaxSize('.5m')).toBe('50m')
    // Un decimal bien formado sí es válido para pino-roll.
    expect(logMaxSize('1.5g')).toBe('1.5g')
    // Las formas que pino-roll sí parsea.
    expect(logMaxSize('500k')).toBe('500k')
    expect(logMaxSize('1g')).toBe('1g')
    expect(logMaxSize('20m')).toBe('20m')
    // La unidad es obligatoria: pino-roll trata un número pelado como MB, así
    // que `52428800` (lo que alguien escribe queriendo 50 MB en bytes) serían
    // 50 TB — rotación apagada de hecho. Al default.
    expect(logMaxSize('100')).toBe('50m')
    expect(logMaxSize('52428800')).toBe('50m')
  })
})
