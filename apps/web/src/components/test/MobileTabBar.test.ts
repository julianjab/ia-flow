import MobileTabBar from '@/components/MobileTabBar.vue'
import { useActiveExecutionsStore } from '@/features/executions/activeStore'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let path = '/projects/p1/tareas'
vi.mock('vue-router', () => ({
  useRoute: () => ({
    get path() {
      return path
    },
  }),
  RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
}))
vi.mock('@/features/executions/api', () => ({ fetchActiveExecutions: vi.fn(async () => []) }))

beforeEach(() => {
  setActivePinia(createPinia())
  path = '/projects/p1/tareas'
})

function mountBar(projectId: string | null = 'p1') {
  return mount(MobileTabBar, {
    props: { projectId },
    global: { stubs: { RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } },
  })
}

// Cada ruta de la barra tiene que EXISTIR en `VALID_TABS`: un tab que apunta a
// una que no existe abre el Overview en silencio, con la URL equivocada en la
// barra de direcciones. Es lo que pasaba con `que-sigue` antes de que existiera.
describe('MobileTabBar', () => {
  it('lleva los tres destinos, relativos al proyecto activo', () => {
    // Eran cuatro: "Qué sigue" se fue porque era la misma lista de Tareas con
    // otro recorte, y dos destinos para la misma pregunta obligan a decidir por
    // cuál entrar antes de saber qué buscabas.
    const hrefs = mountBar()
      .findAll('a')
      .map((a) => a.attributes('href'))
    expect(hrefs).toEqual(['/projects/p1/tareas', '/projects/p1/executions', '/mas'])
  })

  // Sin proyecto no hay a qué proyecto entrar: los de proyecto llevan al
  // listado en vez de a una URL rota.
  it('sin proyecto activo, los tabs de proyecto van al listado', () => {
    const hrefs = mountBar(null)
      .findAll('a')
      .map((a) => a.attributes('href'))
    // `/projects/tareas` lo matchearía el router como el proyecto llamado
    // "tareas": pantalla vacía y fetches contra un id que no existe.
    expect(hrefs.slice(0, 2)).toEqual(['/projects', '/projects'])
    expect(hrefs[2]).toBe('/mas')
  })

  it('marca el tab de la ruta actual', () => {
    const items = mountBar().findAll('.tabbar__item')
    expect(items[0].classes()).toContain('is-active')
  })

  // Board es la otra VISTA de Tareas, no un destino: dejar los tabs apagados
  // mientras se mira el board haría parecer que la barra no sabe dónde estás.
  it('el board cuenta como Tareas', () => {
    path = '/projects/p1/board'
    expect(mountBar().findAll('.tabbar__item')[0].classes()).toContain('is-active')
  })

  // El badge es un punto, no un número: el conteo ya está en la pantalla.
  it('el punto de RUNS aparece sólo si hay algo corriendo', () => {
    expect(mountBar().find('.tabbar__dot').exists()).toBe(false)
    const store = useActiveExecutionsStore()
    store.executions = [{ id: 'r1' }] as never
    store.loaded = true
    expect(mountBar().find('.tabbar__dot').exists()).toBe(true)
  })

  // Un punto quieto que insinúe actividad sin saberlo es peor que ninguno.
  it('sin haber cargado el estado, no se pinta el punto', () => {
    const store = useActiveExecutionsStore()
    store.executions = [{ id: 'r1' }] as never
    store.loaded = false
    expect(mountBar().find('.tabbar__dot').exists()).toBe(false)
  })
})
