import { afterEach, describe, expect, test } from 'bun:test'
import { crashRecoveryEnabled, resolveCatchUp, startupScanEnabled } from './catch-up.js'

const ORIGINAL_SCAN = process.env.IA_FLOW_STARTUP_SCAN
const ORIGINAL_RECOVERY = process.env.IA_FLOW_CRASH_RECOVERY

afterEach(() => {
  if (ORIGINAL_SCAN === undefined) delete process.env.IA_FLOW_STARTUP_SCAN
  else process.env.IA_FLOW_STARTUP_SCAN = ORIGINAL_SCAN
  if (ORIGINAL_RECOVERY === undefined) delete process.env.IA_FLOW_CRASH_RECOVERY
  else process.env.IA_FLOW_CRASH_RECOVERY = ORIGINAL_RECOVERY
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

describe('crashRecoveryEnabled', () => {
  test('on by default, off with a falsy spelling', () => {
    delete process.env.IA_FLOW_CRASH_RECOVERY
    expect(crashRecoveryEnabled()).toBe(true)
    process.env.IA_FLOW_CRASH_RECOVERY = 'off'
    expect(crashRecoveryEnabled()).toBe(false)
  })
})

describe('resolveCatchUp', () => {
  test('boot runs both passes', () => {
    delete process.env.IA_FLOW_STARTUP_SCAN
    expect(resolveCatchUp(true, false)).toEqual({ crashRecovery: true, initialScan: true })
  })

  test('IA_FLOW_STARTUP_SCAN=0 silences the boot scan but NOT crash recovery', () => {
    // Sharing one switch would strand every task left with Working=Yes: no
    // scan looks at them, so nothing would ever clear the flag again.
    process.env.IA_FLOW_STARTUP_SCAN = '0'
    expect(resolveCatchUp(true, true)).toEqual({ crashRecovery: true, initialScan: false })
  })

  test('IA_FLOW_CRASH_RECOVERY=0 silences only the recovery pass', () => {
    process.env.IA_FLOW_CRASH_RECOVERY = '0'
    expect(resolveCatchUp(true, false)).toEqual({ crashRecovery: false, initialScan: true })
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
