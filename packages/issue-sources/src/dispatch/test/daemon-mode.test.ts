import { afterEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_DAEMON_MODE,
  envDaemonMode,
  parseDaemonMode,
  resolveDaemonMode,
} from './daemon-mode.js'

const ORIGINAL = process.env.IA_FLOW_DAEMON_MODE

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.IA_FLOW_DAEMON_MODE
  else process.env.IA_FLOW_DAEMON_MODE = ORIGINAL
})

describe('parseDaemonMode', () => {
  test('accepts canonical values', () => {
    expect(parseDaemonMode('webhook')).toBe('webhook')
    expect(parseDaemonMode('polling')).toBe('polling')
  })

  test('accepts aliases and is case/space insensitive', () => {
    expect(parseDaemonMode(' Pull ')).toBe('polling')
    expect(parseDaemonMode('PULLING')).toBe('polling')
    expect(parseDaemonMode('poll')).toBe('polling')
    expect(parseDaemonMode('push')).toBe('webhook')
    expect(parseDaemonMode('webhooks')).toBe('webhook')
  })

  test('returns null for unknown or non-string input', () => {
    expect(parseDaemonMode('cron')).toBeNull()
    expect(parseDaemonMode(undefined)).toBeNull()
    expect(parseDaemonMode(42)).toBeNull()
  })
})

describe('envDaemonMode', () => {
  test('defaults to webhook when unset', () => {
    delete process.env.IA_FLOW_DAEMON_MODE
    expect(envDaemonMode()).toBe('webhook')
    expect(DEFAULT_DAEMON_MODE).toBe('webhook')
  })

  test('honours the env var', () => {
    process.env.IA_FLOW_DAEMON_MODE = 'polling'
    expect(envDaemonMode()).toBe('polling')
  })

  test('falls back to the default on garbage', () => {
    process.env.IA_FLOW_DAEMON_MODE = 'nonsense'
    expect(envDaemonMode()).toBe('webhook')
  })
})

describe('resolveDaemonMode', () => {
  test('per-project setting wins over env', () => {
    process.env.IA_FLOW_DAEMON_MODE = 'polling'
    expect(resolveDaemonMode({ settings: { daemonMode: 'webhook' } })).toBe('webhook')
  })

  test('falls back to env when the project has no setting', () => {
    process.env.IA_FLOW_DAEMON_MODE = 'pull'
    expect(resolveDaemonMode({ settings: {} })).toBe('polling')
    expect(resolveDaemonMode({ settings: undefined })).toBe('polling')
  })

  test('falls back to webhook when neither is set', () => {
    delete process.env.IA_FLOW_DAEMON_MODE
    expect(resolveDaemonMode({ settings: { other: 1 } })).toBe('webhook')
  })
})
