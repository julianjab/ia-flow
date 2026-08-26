import { describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import { otelStream, resolveLogFile } from './logger.js'

describe('resolveLogFile', () => {
  it('cae al mismo config dir que el state file', () => {
    expect(resolveLogFile({ HOME: '/home/j' })).toBe('/home/j/.config/ia-flow/logs/gateway.log')
  })

  it('sigue IA_FLOW_CONFIG_DIR', () => {
    expect(resolveLogFile({ HOME: '/home/j', IA_FLOW_CONFIG_DIR: '/cfg' })).toBe(
      '/cfg/logs/gateway.log',
    )
  })

  // Mismo env que apps/server: un solo valor manda los dos procesos al mismo
  // directorio, con un archivo cada uno.
  it('IA_FLOW_LOG_DIR gana sobre el config dir', () => {
    expect(resolveLogFile({ IA_FLOW_CONFIG_DIR: '/cfg', IA_FLOW_LOG_DIR: '/var/log/ia' })).toBe(
      '/var/log/ia/gateway.log',
    )
  })

  it('un override explícito gana sobre todo', () => {
    expect(
      resolveLogFile({ IA_FLOW_LOG_DIR: '/var/log/ia', IA_FLOW_GATEWAY_LOG_FILE: '/tmp/gw.log' }),
    ).toBe('/tmp/gw.log')
  })

  // El caso container: los logs los junta el runtime y el archivo sería
  // basura en un filesystem efímero.
  it('un override vacío apaga el archivo', () => {
    expect(resolveLogFile({ HOME: '/home/j', IA_FLOW_GATEWAY_LOG_FILE: '' })).toBeNull()
    expect(resolveLogFile({ HOME: '/home/j', IA_FLOW_GATEWAY_LOG_FILE: '  ' })).toBeNull()
  })
})

describe('otelStream', () => {
  // Mismo contrato que fileTarget(): null es "no puedo / no debo", nunca un
  // throw. El gateway tiene que arrancar aunque la observabilidad no.
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
