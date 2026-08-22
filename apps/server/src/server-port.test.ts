import { describe, expect, it } from 'bun:test'
import { DEFAULT_SERVER_PORT, daemonUrl, resolveServerPort } from './server-port.js'

describe('resolveServerPort', () => {
  it('falls back to the default when nothing is set', () => {
    expect(resolveServerPort({})).toBe(DEFAULT_SERVER_PORT)
  })

  it('prefers IA_FLOW_SERVER_PORT over the legacy PORT alias', () => {
    expect(resolveServerPort({ IA_FLOW_SERVER_PORT: '4001', PORT: '3001' })).toBe(4001)
  })

  it('still honours PORT alone', () => {
    expect(resolveServerPort({ PORT: '3011' })).toBe(3011)
  })

  it('ignores empty values and keeps looking', () => {
    expect(resolveServerPort({ IA_FLOW_SERVER_PORT: '  ', PORT: '3011' })).toBe(3011)
  })

  it('throws on a non-numeric or out-of-range port', () => {
    expect(() => resolveServerPort({ IA_FLOW_SERVER_PORT: 'abc' })).toThrow(/inválido/)
    expect(() => resolveServerPort({ PORT: '99999' })).toThrow(/inválido/)
  })

  it('builds the daemon url from the resolved port', () => {
    expect(daemonUrl({ IA_FLOW_SERVER_PORT: '4001' })).toBe('http://localhost:4001')
  })
})
