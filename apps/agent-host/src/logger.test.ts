import { describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import {
  capExtras,
  clearRunLogTarget,
  createLogger,
  otelResource,
  otelStream,
  redriveTarget,
  resolveLogFile,
  runLogTargetCount,
  setRunLogTarget,
} from './logger.js'

describe('resolveLogFile', () => {
  it('cae al mismo config dir que el state file', () => {
    expect(resolveLogFile({ HOME: '/home/j' })).toBe('/home/j/.config/ia-flow/logs/agent-host.log')
  })

  it('sigue IA_FLOW_CONFIG_DIR', () => {
    expect(resolveLogFile({ HOME: '/home/j', IA_FLOW_CONFIG_DIR: '/cfg' })).toBe(
      '/cfg/logs/agent-host.log',
    )
  })

  // Mismo env que apps/server: un solo valor manda los dos procesos al mismo
  // directorio, con un archivo cada uno.
  it('IA_FLOW_LOG_DIR gana sobre el config dir', () => {
    expect(resolveLogFile({ IA_FLOW_CONFIG_DIR: '/cfg', IA_FLOW_LOG_DIR: '/var/log/ia' })).toBe(
      '/var/log/ia/agent-host.log',
    )
  })

  it('un override explícito gana sobre todo', () => {
    expect(
      resolveLogFile({
        IA_FLOW_LOG_DIR: '/var/log/ia',
        IA_FLOW_AGENT_HOST_LOG_FILE: '/tmp/gw.log',
      }),
    ).toBe('/tmp/gw.log')
  })

  // El caso container: los logs los junta el runtime y el archivo sería
  // basura en un filesystem efímero.
  it('un override vacío apaga el archivo', () => {
    expect(resolveLogFile({ HOME: '/home/j', IA_FLOW_AGENT_HOST_LOG_FILE: '' })).toBeNull()
    expect(resolveLogFile({ HOME: '/home/j', IA_FLOW_AGENT_HOST_LOG_FILE: '  ' })).toBeNull()
  })
})

describe('otelStream', () => {
  // Mismo contrato que fileTarget(): null es "no puedo / no debo", nunca un
  // throw. El agent-host tiene que arrancar aunque la observabilidad no.
  it('devuelve null sin endpoint configurado', () => {
    expect(otelStream({})).toBeNull()
  })

  // El kill switch: hay collector configurado, pero el operador lo apagó.
  it('devuelve null con OTEL_SDK_DISABLED=true', () => {
    expect(
      otelStream({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
        OTEL_SDK_DISABLED: 'true',
      }),
    ).toBeNull()
  })

  it('devuelve un Writable con un endpoint válido', () => {
    const stream = otelStream({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' })
    expect(stream).toBeInstanceOf(Writable)
    stream?.destroy()
  })

  // Un endpoint mal formado es error de config, no motivo para tumbar el
  // proceso en el import: el try/catch lo baja a "sin sink".
  it('no lanza con un endpoint mal formado', () => {
    let stream: Writable | null = null
    expect(() => {
      stream = otelStream({ OTEL_EXPORTER_OTLP_ENDPOINT: 'not a url' })
    }).not.toThrow()
    expect(stream).toBeNull()
  })

  // Un endpoint que son sólo espacios es "no configurado", no una URL rota.
  it('trata un endpoint en blanco como apagado', () => {
    expect(otelStream({ OTEL_EXPORTER_OTLP_ENDPOINT: '   ' })).toBeNull()
  })

  // El write nunca puede frenar el stream: por multistream, un cb() que no se
  // llama frena el logging entero — el archivo incluido.
  it('un record ilegible no rompe el stream ni traga el callback', () => {
    const stream = otelStream({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' })
    expect(stream).not.toBeNull()
    let called = false
    stream?._write(Buffer.from('esto no es json\n'), 'utf8', () => {
      called = true
    })
    expect(called).toBe(true)
    stream?.destroy()
  })
})

describe('otelResource', () => {
  // Los cuatro atributos de la tabla del ADR (Q3): sin ellos, un record que
  // llega al collector no se puede atribuir a este proceso.
  it('estampa los cuatro atributos del ADR', () => {
    const attrs = otelResource({}).attributes
    expect(attrs['service.name']).toBe('ia-flow-agent-host')
    expect(attrs['service.instance.id']).toBe(String(process.pid))
    expect(attrs['service.version']).toBeString()
    expect(attrs['deployment.environment.name']).toBe('development')
  })

  it('los overrides del entorno ganan sobre los defaults', () => {
    const attrs = otelResource({
      OTEL_SERVICE_NAME: 'gw-roster-a',
      IA_FLOW_INSTANCE_ID: 'laptop-julian',
      OTEL_DEPLOYMENT_ENVIRONMENT: 'production',
    }).attributes
    expect(attrs['service.name']).toBe('gw-roster-a')
    expect(attrs['service.instance.id']).toBe('laptop-julian')
    expect(attrs['deployment.environment.name']).toBe('production')
  })

  // OTEL_RESOURCE_ATTRIBUTES es lo que promete el ADR para que un deploy sume
  // los suyos sin tocar código — sólo funciona si se pide el envDetector.
  it('suma los attrs de OTEL_RESOURCE_ATTRIBUTES sin dejar que pisen los nuestros', () => {
    const previo = process.env.OTEL_RESOURCE_ATTRIBUTES
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'k8s.pod.name=pod-7,service.name=impostor'
    try {
      const attrs = otelResource({}).attributes
      expect(attrs['k8s.pod.name']).toBe('pod-7')
      expect(attrs['service.name']).toBe('ia-flow-agent-host')
    } finally {
      if (previo === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES
      else process.env.OTEL_RESOURCE_ATTRIBUTES = previo
    }
  })
})

// `createLogger` es lo que el agent-host le pasa a `setToolsLoggerFactory`
// (providers.ts), y el `Logger` de @ia-flow/tools exige `child()` porque
// `executeLoop` bindea ahí la correlación del run. Sin `child`, ese wiring no
// compila y el loop de tools del agent-host vuelve al stub no-op.
describe('createLogger', () => {
  it('expone los cuatro niveles y child()', () => {
    const log = createLogger('probe')
    for (const level of ['info', 'warn', 'error', 'debug', 'child'] as const) {
      expect(typeof log[level]).toBe('function')
    }
  })

  it('child() devuelve la MISMA interfaz, no el pino crudo', () => {
    const child = createLogger('probe').child({ runId: 'r-1' })
    for (const level of ['info', 'warn', 'error', 'debug', 'child'] as const) {
      expect(typeof child[level]).toBe('function')
    }
    // Anidable: executeLoop puede encadenar sin conocer la implementación.
    expect(typeof child.child({ taskId: 't-1' }).info).toBe('function')
  })

  it('no tira al loguear por un child', () => {
    expect(() => createLogger('probe').child({ runId: 'r-1' }).info({ a: 1 }, 'ok')).not.toThrow()
  })
})

// El redrive: qué línea vuelve al daemon que despachó el run, y cuál se queda
// local. La decisión es lo que hay que poder testear — el `fetch` no.
describe('redriveTarget', () => {
  it('sin runId la línea se queda local', () => {
    expect(redriveTarget({ msg: 'boot' })).toBeNull()
  })

  it('con un runId desconocido se queda local', () => {
    expect(redriveTarget({ runId: 'r-desconocido' })).toBeNull()
  })

  it('con un runId registrado vuelve al daemon de ESE run', () => {
    setRunLogTarget('r-1', 'http://daemon-a:3001')
    setRunLogTarget('r-2', 'http://daemon-b:3001')
    expect(redriveTarget({ runId: 'r-1' })).toBe('http://daemon-a:3001')
    expect(redriveTarget({ runId: 'r-2' })).toBe('http://daemon-b:3001')
    clearRunLogTarget('r-1')
    clearRunLogTarget('r-2')
  })

  it('normaliza la barra final para no armar //api/remote-logs', () => {
    setRunLogTarget('r-3', 'http://daemon-a:3001/')
    expect(redriveTarget({ runId: 'r-3' })).toBe('http://daemon-a:3001')
    clearRunLogTarget('r-3')
  })

  // El `finally` de /v1/run: sin esto el mapa crece y un runId reciclado
  // mandaría líneas al daemon equivocado.
  it('clear deja de reenviar', () => {
    setRunLogTarget('r-4', 'http://daemon-a:3001')
    clearRunLogTarget('r-4')
    expect(redriveTarget({ runId: 'r-4' })).toBeNull()
    expect(runLogTargetCount()).toBe(0)
  })

  it('un runId que no es string no matchea', () => {
    setRunLogTarget('5', 'http://daemon-a:3001')
    expect(redriveTarget({ runId: 5 })).toBeNull()
    clearRunLogTarget('5')
  })
})

describe('capExtras', () => {
  it('deja pasar un extras chico tal cual', () => {
    const extras = { runId: 'r-1', event: 'tool.call', tool: 'bash_run' }
    expect(capExtras(extras)).toEqual(extras)
  })

  // `bash_run` devuelve hasta 20 KB y el receptor corta en 20 KB: sin recortar,
  // las líneas más interesantes serían las únicas rechazadas.
  it('recorta conservando la correlación', () => {
    const capped = capExtras({
      runId: 'r-1',
      agent: 'reviewer',
      taskId: 't-9',
      event: 'tool.result',
      tool: 'bash_run',
      output: 'x'.repeat(40_000),
    })
    expect(capped.runId).toBe('r-1')
    expect(capped.agent).toBe('reviewer')
    expect(capped.tool).toBe('bash_run')
    expect(capped.output).toBeUndefined()
    expect(capped.redriveTruncated).toBeGreaterThan(40_000)
  })

  it('un extras no serializable no tira', () => {
    const circular: Record<string, unknown> = { runId: 'r-1' }
    circular.self = circular
    expect(() => capExtras(circular)).not.toThrow()
    expect(capExtras(circular).redriveError).toBeTruthy()
  })
})
