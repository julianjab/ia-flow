import { describe, expect, it } from 'bun:test'
import { resolveLogFile } from './logger.js'

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
