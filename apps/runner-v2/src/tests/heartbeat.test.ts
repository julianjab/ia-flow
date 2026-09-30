import { describe, expect, it } from 'bun:test'
import { HEARTBEAT_PREFIX, heartbeatLine, startHeartbeat } from '../heartbeat.js'

describe('heartbeat', () => {
  it('beats right away with the execution counts, under the prefix the dashboard looks for', () => {
    const lines: string[] = []
    const stop = startHeartbeat(
      () => ({ running: 2, waiting: 1, paused: 3 }),
      60_000,
      (line) => lines.push(line),
    )
    stop()
    expect(lines).toEqual(['runner vivo: 2 corriendo · 3 pausadas · 1 en cola'])
    expect(heartbeatLine({ running: 0, waiting: 0, paused: 0 }).startsWith(HEARTBEAT_PREFIX)).toBe(
      true,
    )
  })

  it('keeps beating until stopped', async () => {
    let beats = 0
    const stop = startHeartbeat(
      () => ({ running: 0, waiting: 0, paused: 0 }),
      5,
      () => beats++,
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    stop()
    const after = beats
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(after).toBeGreaterThan(1)
    expect(beats).toBe(after)
  })
})
