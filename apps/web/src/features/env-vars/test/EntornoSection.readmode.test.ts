import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvVarState } from '@/features/env-vars/api'
import EntornoSection from '../EntornoSection.vue'

// El modo lectura/edición por grupo sólo aparece arriba de ocho variables
// (`READ_MODE_FROM`), así que este archivo trae un grupo grande — el de la
// suite principal tiene tres y nunca lo cruza.
const VARS: Record<string, EnvVarState> = Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => [
    `IA_FLOW_VAR_${i}`,
    {
      isSet: true,
      secret: false,
      value: `v${i}`,
      source: 'db',
      savedButUnused: false,
      label: `Var ${i}`,
      description: '',
      kind: 'text',
      group: 'daemon',
      groupLabel: 'Daemon',
    } satisfies EnvVarState,
  ]),
)

vi.mock('@/features/env-vars/api', () => ({
  getEnvVars: vi.fn(async () => VARS),
  updateEnvVars: vi.fn(async () => {}),
}))
vi.mock('@/features/webhook-status/WebhookStatusCard.vue', () => ({
  default: { template: '<div />', props: ['secretConfigured'] },
}))

async function mountSection() {
  const wrapper = mount(EntornoSection)
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('EntornoSection — lectura y edición por grupo', () => {
  /**
   * Entrar en modo edición era de ida: la única salida era guardar o recargar
   * la página, así que abrir un grupo "para mirar" obligaba a decidir.
   */
  it('vuelve a lectura con `listo` cuando no hay cambios', async () => {
    const w = await mountSection()
    expect(w.findAll('.env-var-row')).toHaveLength(0)

    await w.get('[data-testid="env-edit-daemon"]').trigger('click')
    expect(w.findAll('.env-var-row')).toHaveLength(10)

    const done = w.get('[data-testid="env-done-daemon"]')
    expect(done.text()).toBe('listo')
    await done.trigger('click')

    expect(w.findAll('.env-var-row')).toHaveLength(0)
  })

  /**
   * Con cambios sin guardar, salir los descarta — y el botón lo dice antes de
   * tocarlo. Dejarlos vivos detrás de un modo lectura que muestra el valor
   * persistido sería mostrar un valor y mandar otro.
   */
  it('con cambios sin guardar avisa qué descarta, y los descarta', async () => {
    const w = await mountSection()
    await w.get('[data-testid="env-edit-daemon"]').trigger('click')

    await w.findAll('.env-var-row input')[0].setValue('editado')
    expect(w.get('[data-testid="env-done-daemon"]').text()).toBe('descartar 1 y cerrar')

    await w.get('[data-testid="env-done-daemon"]').trigger('click')
    await w.get('[data-testid="env-edit-daemon"]').trigger('click')

    expect((w.findAll('.env-var-row input')[0].element as HTMLInputElement).value).toBe('v0')
  })
})
