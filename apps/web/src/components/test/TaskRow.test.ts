import TaskRow from '@/components/TaskRow.vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

const base = { title: 'Arreglar el proxy', issueNumber: 42 }

describe('TaskRow', () => {
  it('sin `selected` no marca nada', () => {
    const w = mount(TaskRow, { props: base })
    expect(w.find('.tr').classes()).not.toContain('is-selected')
    expect(w.find('.tr').attributes('aria-current')).toBeUndefined()
  })

  // Con dos columnas a la vista, la fila abierta es lo único que ata la lista
  // con el detalle: sin la marca no se sabe cuál de todas se está mirando.
  it('la fila abierta se marca, y lo dice también para el lector de pantalla', () => {
    const w = mount(TaskRow, { props: { ...base, selected: true } })
    expect(w.find('.tr').classes()).toContain('is-selected')
    expect(w.find('.tr').attributes('aria-current')).toBe('true')
  })
})
