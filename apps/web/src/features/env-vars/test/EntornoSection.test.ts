import type { EnvVarState } from '@/features/env-vars/api'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import EntornoSection from '../EntornoSection.vue'

// El estado que devuelve `GET /api/env-vars`. Lo relevante para este test:
// `value` sale de `dbVal ?? Bun.env[key]` del lado del server, así que una
// variable que sólo vive en el ENTORNO del proceso llega con su valor cargado
// y `isSet: true` igual que una guardada — `source` es lo único que las
// distingue.
const VARS: Record<string, EnvVarState> = {
  LOG_LEVEL: {
    isSet: true,
    secret: false,
    value: 'info', // ← del runner.yaml, NO de la DB
    source: 'env',
    savedButUnused: false,
    label: 'Log level',
    description: '',
    kind: 'text',
    group: 'daemon',
    groupLabel: 'Daemon',
  },
  IA_FLOW_DAEMON_MODE: {
    isSet: true,
    secret: false,
    value: 'webhook', // ← también del runner.yaml
    source: 'env',
    savedButUnused: false,
    label: 'Modo del daemon',
    description: '',
    kind: 'text',
    group: 'daemon',
    groupLabel: 'Daemon',
  },
  GITHUB_TOKEN: {
    isSet: true,
    secret: true,
    value: null, // los secretos nunca viajan
    // Guardado en la DB pero TAPADO por el entorno: el caso que el cartel
    // existe para explicar — guardaste y no pasó nada.
    source: 'env',
    savedButUnused: true,
    label: 'GitHub Token',
    description: '',
    kind: 'password',
    group: 'github',
    groupLabel: 'GitHub',
  },
}

const updateEnvVars = vi.fn(async () => {})
vi.mock('@/features/env-vars/api', () => ({
  getEnvVars: vi.fn(async () => VARS),
  updateEnvVars: (patch: Record<string, string>) => updateEnvVars(patch),
}))
// La tarjeta del webhook hace lo suyo (fetch del túnel) y no es lo que se
// prueba acá.
vi.mock('@/features/webhook-status/WebhookStatusCard.vue', () => ({
  default: { template: '<div />', props: ['secretConfigured'] },
}))

async function mountSection() {
  const wrapper = mount(EntornoSection)
  await flushPromises()
  return wrapper
}

/** Los inputs se renderizan en el orden de `envGroups`; los ubicamos por el
 *  `<code>` con el nombre de la variable que va en la misma fila. */
function inputFor(wrapper: Awaited<ReturnType<typeof mountSection>>, key: string) {
  const row = wrapper.findAll('.env-var-row').find((r) => r.get('.env-var-key').text() === key)
  if (!row) throw new Error(`fila no encontrada para ${key}`)
  return row.get('input')
}

describe('EntornoSection — qué se manda al guardar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    updateEnvVars.mockClear()
  })

  it('no persiste las variables que vienen del entorno cuando se guarda otro campo', async () => {
    // Ésta es la regresión: antes el form mandaba TODAS las no secretas, así
    // que guardar un cambio en `IA_FLOW_DAEMON_MODE` escribía también
    // `LOG_LEVEL=info` en la DB. Desde ahí `loadIntoProcess()` —que corre
    // DESPUÉS del volcado del runner.yaml y pisa incondicionalmente— hacía que
    // la fila le ganara al YAML para siempre.
    const wrapper = await mountSection()
    await inputFor(wrapper, 'IA_FLOW_DAEMON_MODE').setValue('polling')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(updateEnvVars).toHaveBeenCalledTimes(1)
    expect(updateEnvVars).toHaveBeenCalledWith({ IA_FLOW_DAEMON_MODE: 'polling' })
  })

  it('no manda nada si no se tocó ningún campo', async () => {
    const wrapper = await mountSection()
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(updateEnvVars).not.toHaveBeenCalled()
  })

  it('manda `` al vaciar una no-secreta, que es cómo se borra', async () => {
    const wrapper = await mountSection()
    await inputFor(wrapper, 'LOG_LEVEL').setValue('')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(updateEnvVars).toHaveBeenCalledWith({ LOG_LEVEL: '' })
  })

  it('manda el secreto sólo cuando se escribió uno nuevo', async () => {
    const wrapper = await mountSection()
    await inputFor(wrapper, 'GITHUB_TOKEN').setValue('ghp_nuevo')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(updateEnvVars).toHaveBeenCalledWith({ GITHUB_TOKEN: 'ghp_nuevo' })
  })

  // La precedencia (lo guardado acá le gana al entorno) no se puede deducir
  // mirando la pantalla: sin estos carteles, una variable del compose y una
  // guardada se ven idénticas, y la que sobrescribe al entorno es
  // indistinguible de la que no.
  describe('procedencia del valor', () => {
    function badgeFor(wrapper: ReturnType<typeof mount>, key: string) {
      const row = wrapper.findAll('.env-var-row').find((r) => r.find('.env-var-key').text() === key)
      return row?.find('span[title]')
    }

    it('taguea como `env` la que el proceso trajo del ambiente', async () => {
      const wrapper = await mountSection()
      const badge = badgeFor(wrapper, 'LOG_LEVEL')
      expect(badge?.text()).toBe('env')
      expect(badge?.attributes('title')).toContain('entorno del proceso')
    })

    it('avisa cuando hay algo guardado que el entorno está tapando', async () => {
      // El tag nombra la fuente en uso —`env`, porque el entorno gana— y el
      // color marca que además hay una fila guardada que NO se aplica. Es la
      // única explicación posible de "guardé y no cambió nada".
      const wrapper = await mountSection()
      const badge = badgeFor(wrapper, 'GITHUB_TOKEN')
      expect(badge?.text()).toBe('env')
      expect(badge?.classes()).toContain('env-override-badge')
      expect(badge?.attributes('title')).toContain('NO se está aplicando')
    })
  })
})
