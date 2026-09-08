import LogLine from '@/ui/LogLine.vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

describe('LogLine', () => {
  it('dibuja los cuatro datos en el orden de lectura', () => {
    // Un stream se escanea por POSICIÓN, no leyendo cada campo: el orden es
    // parte del contrato, no una preferencia.
    const w = mount(LogLine, {
      props: { time: '09:41:02', level: 'warn', origin: 'dispatcher', message: 'sin cuota' },
    })
    expect(w.get('.ll__time').text()).toBe('09:41:02')
    expect(w.get('.ll__origin').text()).toBe('dispatcher')
    expect(w.get('.ll__msg').text()).toBe('sin cuota')
  })

  it('el nivel es el color de un GLIFO, no un badge', () => {
    // Cuarenta badges de colores en una columna se leen como una alarma
    // constante y le sacan el peso visual al mensaje, que es el dato.
    const w = mount(LogLine, { props: { time: '1', level: 'error', message: 'x' } })
    expect(w.get('.ll__glyph').text()).toBe('✕')
    expect(w.classes()).toContain('ll--error')
  })

  it('`fatal` comparte glifo con `error`', () => {
    // Para quien mira la lista son lo mismo —algo se rompió—; la diferencia
    // vive en el detalle.
    const w = mount(LogLine, { props: { time: '1', level: 'fatal', message: 'x' } })
    expect(w.get('.ll__glyph').text()).toBe('✕')
  })

  it('el mensaje completo queda accesible sin envolver la línea', () => {
    const largo = 'a'.repeat(400)
    const w = mount(LogLine, { props: { time: '1', level: 'info', message: largo } })
    // Se trunca por CSS y se ofrece entero en el title: una línea de log no se
    // parte en dos, se trunca y se abre.
    expect(w.get('.ll__msg').attributes('title')).toBe(largo)
  })

  it('sin origen no dibuja una celda vacía', () => {
    const w = mount(LogLine, { props: { time: '1', level: 'info', message: 'x' } })
    expect(w.find('.ll__origin').exists()).toBe(false)
  })
})
