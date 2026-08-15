import { afterEach, describe, expect, test } from 'bun:test'
import { resolveCatchUp, startupScanEnabled } from './catch-up.js'

const ORIGINAL = process.env.IA_FLOW_STARTUP_SCAN

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.IA_FLOW_STARTUP_SCAN
  else process.env.IA_FLOW_STARTUP_SCAN = ORIGINAL
})

describe('startupScanEnabled', () => {
  test('on by default, off for the usual falsy spellings', () => {
    delete process.env.IA_FLOW_STARTUP_SCAN
    expect(startupScanEnabled()).toBe(true)
    for (const raw of ['0', 'false', 'no', 'off', 'OFF']) {
      process.env.IA_FLOW_STARTUP_SCAN = raw
      expect(startupScanEnabled()).toBe(false)
    }
    process.env.IA_FLOW_STARTUP_SCAN = '1'
    expect(startupScanEnabled()).toBe(true)
  })
})

describe('resolveCatchUp', () => {
  test('boot runs both passes', () => {
    delete process.env.IA_FLOW_STARTUP_SCAN
    expect(resolveCatchUp(true, false)).toEqual({ crashRecovery: true, initialScan: true })
  })

  test('IA_FLOW_STARTUP_SCAN=0 silences the boot pass', () => {
    process.env.IA_FLOW_STARTUP_SCAN = '0'
    expect(resolveCatchUp(true, true)).toEqual({ crashRecovery: false, initialScan: false })
  })

  test('a reload never runs crash recovery — it would strip live `working` flags', () => {
    delete process.env.IA_FLOW_STARTUP_SCAN
    expect(resolveCatchUp(false, true).crashRecovery).toBe(false)
    expect(resolveCatchUp(false, false).crashRecovery).toBe(false)
  })

  test('a new manager still gets its first scan on reload, even with the flag off', () => {
    process.env.IA_FLOW_STARTUP_SCAN = '0'
    expect(resolveCatchUp(false, true).initialScan).toBe(true)
    expect(resolveCatchUp(false, false).initialScan).toBe(false)
  })
})
