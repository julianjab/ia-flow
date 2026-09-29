import { describe, expect, it } from 'vitest'
import { ExecutionScheduler } from '../ExecutionScheduler.js'
import { KeyedQueue } from '../KeyedQueue.js'
import { Semaphore } from '../Semaphore.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('KeyedQueue', () => {
  it('serializes turns of the same key and frees the key after the last one', async () => {
    const queue = new KeyedQueue()
    const first = queue.enqueue('a')
    const second = queue.enqueue('a')
    let secondReady = false
    void second.ready.then(() => {
      secondReady = true
    })

    await first.ready
    await tick()
    expect(secondReady).toBe(false)
    first.release()
    await second.ready
    expect(queue.busy('a')).toBe(true)
    second.release()
    expect(queue.busy('a')).toBe(false)
  })

  it('does not make different keys wait for each other', async () => {
    const queue = new KeyedQueue()
    queue.enqueue('a')
    await queue.enqueue('b').ready
    expect(queue.busy('a')).toBe(true)
  })
})

describe('Semaphore', () => {
  it('hands the slot straight to the next waiter', async () => {
    const semaphore = new Semaphore(1)
    await semaphore.acquire()
    let second = false
    const waiting = semaphore.acquire().then(() => {
      second = true
    })
    await tick()
    expect(second).toBe(false)
    semaphore.release()
    await waiting
    expect(semaphore.active).toBe(1)
    semaphore.release()
    expect(semaphore.active).toBe(0)
  })

  it('rejects a cap below one', () => {
    expect(() => new Semaphore(0)).toThrow(/≥ 1/)
  })
})

describe('ExecutionScheduler', () => {
  it('marks the task busy in the same tick and counts who waits', async () => {
    const scheduler = new ExecutionScheduler(1)
    const a = scheduler.enter('a')
    expect(scheduler.busy('a')).toBe(true)
    await a.ready
    const b = scheduler.enter('b')
    await tick()
    expect(scheduler.waiting).toBe(1)
    expect(scheduler.running).toBe(1)

    a.release()
    await b.ready
    expect(scheduler.waiting).toBe(0)
    expect(scheduler.busy('a')).toBe(false)
    b.release()
    expect(scheduler.running).toBe(0)
  })
})
