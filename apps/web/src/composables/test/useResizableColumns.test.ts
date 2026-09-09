import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useResizableColumns } from '@/composables/useResizableColumns'

function move(clientX: number) {
  window.dispatchEvent(Object.assign(new Event('pointermove'), { clientX }) as PointerEvent)
}

function up() {
  window.dispatchEvent(new Event('pointerup'))
}

function press(clientX: number, button = 0) {
  return { clientX, button, cancelable: false, preventDefault() {} } as unknown as PointerEvent
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

const columns = [
  { key: 'anchor', track: '16px' },
  { key: 'title', track: 'minmax(0, 1fr)' },
  { key: 'issue', defaultWidth: 60, minWidth: 40 },
]

describe('useResizableColumns', () => {
  it('arranca en los defaults sin nada guardado', () => {
    const { gridTemplateColumns } = useResizableColumns('t1', columns)
    expect(gridTemplateColumns.value).toBe('16px minmax(0, 1fr) 60px')
  })

  it('arrastrar el handle cambia el ancho de esa columna', () => {
    const { startResize, gridTemplateColumns } = useResizableColumns('t2', columns)
    startResize('issue', press(100))
    move(140)
    up()
    expect(gridTemplateColumns.value).toBe('16px minmax(0, 1fr) 100px')
  })

  it('no baja del mínimo declarado', () => {
    const { startResize, gridTemplateColumns } = useResizableColumns('t3', columns)
    startResize('issue', press(100))
    move(0)
    up()
    expect(gridTemplateColumns.value).toBe('16px minmax(0, 1fr) 40px')
  })

  it('una columna fija o flexible no se puede arrastrar', () => {
    const { startResize, gridTemplateColumns } = useResizableColumns('t4', columns)
    startResize('title', press(100))
    move(300)
    up()
    expect(gridTemplateColumns.value).toBe('16px minmax(0, 1fr) 60px')
  })

  it('el botón secundario no arranca el gesto', () => {
    const { startResize, gridTemplateColumns } = useResizableColumns('t5', columns)
    startResize('issue', press(100, 2))
    move(300)
    up()
    expect(gridTemplateColumns.value).toBe('16px minmax(0, 1fr) 60px')
  })

  it('persiste el ancho y lo recupera en la siguiente instancia', () => {
    const first = useResizableColumns('t6', columns)
    first.startResize('issue', press(100))
    move(150)
    up()
    expect(first.gridTemplateColumns.value).toBe('16px minmax(0, 1fr) 110px')

    const second = useResizableColumns('t6', columns)
    expect(second.gridTemplateColumns.value).toBe('16px minmax(0, 1fr) 110px')
  })

  it('un ancho guardado bajo el mínimo actual se descarta', () => {
    localStorage.setItem('ia-flow:col-widths:t7', JSON.stringify({ issue: 10 }))
    const { gridTemplateColumns } = useResizableColumns('t7', columns)
    expect(gridTemplateColumns.value).toBe('16px minmax(0, 1fr) 60px')
  })

  it('storageKeys distintas no se pisan', () => {
    const a = useResizableColumns('t8a', columns)
    a.startResize('issue', press(100))
    move(200)
    up()

    const b = useResizableColumns('t8b', columns)
    expect(b.gridTemplateColumns.value).toBe('16px minmax(0, 1fr) 60px')
  })
})
