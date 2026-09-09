import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyTaskOrderPref,
  clearTaskOrderPref,
  getTaskOrderPref,
  setTaskOrderPref,
} from '@/features/tasks/taskOrderPref'

beforeEach(() => {
  localStorage.clear()
})

describe('taskOrderPref', () => {
  it('getTaskOrderPref devuelve null sin nada guardado', () => {
    expect(getTaskOrderPref('p1')).toBeNull()
  })

  it('setTaskOrderPref + getTaskOrderPref hacen ida y vuelta, scopeado por proyecto', () => {
    setTaskOrderPref('p1', ['t2', 't1'])
    expect(getTaskOrderPref('p1')).toEqual(['t2', 't1'])
    expect(getTaskOrderPref('p2')).toBeNull()
  })

  it('clearTaskOrderPref borra sólo la del proyecto dado', () => {
    setTaskOrderPref('p1', ['t1'])
    setTaskOrderPref('p2', ['t2'])
    clearTaskOrderPref('p1')
    expect(getTaskOrderPref('p1')).toBeNull()
    expect(getTaskOrderPref('p2')).toEqual(['t2'])
  })

  it('getTaskOrderPref ignora un valor corrupto (no es array de strings)', () => {
    localStorage.setItem('ia-flow:taskOrderPref:p1', JSON.stringify({ not: 'an array' }))
    expect(getTaskOrderPref('p1')).toBeNull()
  })

  it('applyTaskOrderPref sin preferencia devuelve la lista tal cual', () => {
    const items = [{ id: 't1' }, { id: 't2' }]
    expect(applyTaskOrderPref(items, null)).toBe(items)
  })

  it('applyTaskOrderPref reordena según la preferencia guardada', () => {
    const items = [{ id: 't1' }, { id: 't2' }, { id: 't3' }]
    expect(applyTaskOrderPref(items, ['t3', 't1']).map((i) => i.id)).toEqual(['t3', 't1', 't2'])
  })

  it('applyTaskOrderPref manda las tareas nuevas (no en la preferencia) al final, en su orden original', () => {
    const items = [{ id: 't1' }, { id: 't2' }, { id: 't3' }]
    expect(applyTaskOrderPref(items, ['t2']).map((i) => i.id)).toEqual(['t2', 't1', 't3'])
  })

  it('applyTaskOrderPref ignora ids de la preferencia que ya no existen', () => {
    const items = [{ id: 't1' }]
    expect(applyTaskOrderPref(items, ['fantasma', 't1']).map((i) => i.id)).toEqual(['t1'])
  })
})
