import { useDispositionOrder } from '@/composables/useDispositionOrder'
import { describe, expect, it } from 'vitest'
import { ref } from 'vue'

const row = (id: string, disposition = 'waiting-on-you') =>
  ({ id, disposition }) as { id: string; disposition: 'waiting-on-you' }

describe('useDispositionOrder', () => {
  it('sin congelar todavía, devuelve lo que llega', () => {
    const rows = ref([row('a'), row('b')])
    const { ordered, movedCount } = useDispositionOrder(rows)
    expect(ordered.value.map((r) => r.id)).toEqual(['a', 'b'])
    expect(movedCount.value).toBe(0)
  })

  it('congelado, el orden NO se mueve cuando llega otro — y lo cuenta', () => {
    // Es todo el punto: con el socket vivo, un orden que se recalcula solo
    // mueve la fila que ibas a tocar bajo el dedo.
    const rows = ref([row('a'), row('b'), row('c')])
    const { ordered, movedCount, freeze } = useDispositionOrder(rows)
    freeze()

    rows.value = [row('c'), row('a'), row('b')]
    expect(ordered.value.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(movedCount.value).toBe(3)

    freeze()
    expect(ordered.value.map((r) => r.id)).toEqual(['c', 'a', 'b'])
    expect(movedCount.value).toBe(0)
  })

  it('`freezeIfFirst` congela una sola vez', () => {
    const rows = ref([row('a'), row('b')])
    const { ordered, freezeIfFirst } = useDispositionOrder(rows)
    freezeIfFirst()
    rows.value = [row('b'), row('a')]
    freezeIfFirst()
    expect(ordered.value.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('una fila nueva va al final: meterla en su lugar sería reordenar sin permiso', () => {
    const rows = ref([row('a'), row('b')])
    const { ordered, freeze } = useDispositionOrder(rows)
    freeze()
    rows.value = [row('nueva'), row('a'), row('b')]
    expect(ordered.value.map((r) => r.id)).toEqual(['a', 'b', 'nueva'])
  })

  it('una fila que desapareció no deja un hueco', () => {
    const rows = ref([row('a'), row('b'), row('c')])
    const { ordered, freeze } = useDispositionOrder(rows)
    freeze()
    rows.value = [row('a'), row('c')]
    expect(ordered.value.map((r) => r.id)).toEqual(['a', 'c'])
  })

  it('agrupa en el orden de los cuatro buckets y no dibuja los vacíos', () => {
    const rows = ref([
      row('cerrada', 'closed') as never,
      row('espera') as never,
      row('corre', 'moving') as never,
    ])
    const { buckets } = useDispositionOrder(rows)
    // El orden de los buckets es fijo, no el de llegada.
    expect(buckets.value.map((b) => b.disposition)).toEqual(['waiting-on-you', 'moving', 'closed'])
    // `blocked` no está: un encabezado que cuenta cero es chrome (R10).
    expect(buckets.value.some((b) => b.disposition === 'blocked')).toBe(false)
  })

  it('`reset` descongela — es lo que hace un cambio de proyecto', () => {
    const rows = ref([row('a'), row('b')])
    const { ordered, freeze, reset } = useDispositionOrder(rows)
    freeze()
    reset()
    rows.value = [row('b'), row('a')]
    expect(ordered.value.map((r) => r.id)).toEqual(['b', 'a'])
  })
})
