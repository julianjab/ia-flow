// Estado compartido de LA consola del agent-host elegido.
//
// Antes vivía inline en `AgentHostConsole.vue`, que además era la única
// pantalla: provider, workspace, admisión y servers competían por ancho en
// una misma grilla. Separarlas en rutas propias (una por tab, como
// `/general/:tab` para el server) significa que más de un componente de
// pantalla necesita el mismo estado de conexión y el mismo poll de 5s — de
// ahí que suba a store en vez de quedar en un `ref` de un solo componente.

import type { SystemPromptBlock } from '@ia-flow/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  type AgentHostAdmission,
  type AgentHostCapacity,
  type AgentHostProvider,
  type AgentHostRegistration,
  type AgentHostWorkspace,
  addRegistration,
  agentHostErrorMessage,
  fetchAdmission,
  fetchCapacity,
  fetchProvider,
  fetchRegistrations,
  fetchSystemPrompt,
  fetchWorkspace,
  removeRegistration,
  saveAdmission,
  saveSystemPrompt,
  saveWorkspace,
  setProvider,
} from './api'
import { isAgentHostSelected, selectedAgentHostClient, selectedAgentHostUrl } from './connection'

export const useAgentHostStore = defineStore('agentHost', () => {
  const status = ref<'ok' | 'error' | 'loading'>('loading')
  const statusText = ref('conectando…')
  const saving = ref<string | null>(null)

  const provider = ref<AgentHostProvider | null>(null)
  const capacity = ref<AgentHostCapacity | null>(null)
  const admission = ref<AgentHostAdmission | null>(null)
  const workspace = ref<AgentHostWorkspace | null>(null)
  const registrations = ref<AgentHostRegistration[]>([])
  const systemPrompt = ref<SystemPromptBlock[] | null>(null)

  const url = computed(() => selectedAgentHostUrl())

  async function refresh(): Promise<void> {
    status.value = 'loading'
    try {
      const c = selectedAgentHostClient()
      // En paralelo: son seis lecturas independientes del mismo proceso, y en
      // serie la pantalla tardaría seis round-trips en pintar.
      const [p, cap, adm, ws, regs, sp] = await Promise.all([
        fetchProvider(c),
        fetchCapacity(c),
        fetchAdmission(c),
        fetchWorkspace(c),
        fetchRegistrations(c),
        fetchSystemPrompt(c),
      ])
      provider.value = p
      capacity.value = cap
      admission.value = adm
      workspace.value = ws
      registrations.value = regs.registrations
      systemPrompt.value = sp
      status.value = 'ok'
      statusText.value = `${p.name} · ${cap.running} en curso`
    } catch (err) {
      status.value = 'error'
      statusText.value = agentHostErrorMessage(err)
    }
  }

  /** Toda escritura vuelve a leer: el agent-host puede normalizar lo que
   *  mandamos (recorta, descarta reglas inválidas) y la pantalla debe mostrar
   *  lo que quedó guardado, no lo que creímos guardar. */
  async function withSave(key: string, fn: () => Promise<unknown>): Promise<void> {
    saving.value = key
    try {
      await fn()
      await refresh()
    } catch (err) {
      status.value = 'error'
      statusText.value = agentHostErrorMessage(err)
    } finally {
      saving.value = null
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined
  let refCount = 0

  /**
   * Arranca el poll de 5s la primera vez que una pantalla lo pide, y lo para
   * cuando la última se desmonta.
   *
   * Con un `refCount` en vez de un solo `onMounted`/`onUnmounted`: la ruta
   * de tabs (`AgentHostView`) monta una vez y sobrevive a cambiar de tab
   * (mismo componente, cambia el param), pero un deep-link directo a
   * `/agent-host/servers` seguido de volver a `/agent-host/provider` no
   * debería dejar dos intervalos corriendo si en algún momento se navega
   * entre dos pantallas que cada una llama a `start()` por su cuenta.
   */
  function start(): void {
    refCount += 1
    if (timer) return
    if (!isAgentHostSelected()) return
    void refresh()
    // La ocupación cambia sola (otros daemons despachan a este agent-host):
    // sin refresco, "0 en curso" quedaría mintiendo hasta que alguien recargue.
    timer = setInterval(() => {
      if (status.value !== 'loading') void refresh()
    }, 5_000)
  }

  function stop(): void {
    refCount = Math.max(0, refCount - 1)
    if (refCount > 0) return
    clearInterval(timer)
    timer = undefined
  }

  return {
    status,
    statusText,
    saving,
    provider,
    capacity,
    admission,
    workspace,
    registrations,
    systemPrompt,
    url,
    start,
    stop,
    setProvider: (id: string) =>
      withSave('provider', () => setProvider(selectedAgentHostClient(), id)),
    saveWorkspace: (ws: AgentHostWorkspace) =>
      withSave('workspace', () => saveWorkspace(selectedAgentHostClient(), ws)),
    saveSystemPrompt: (blocks: SystemPromptBlock[]) =>
      withSave('systemPrompt', () => saveSystemPrompt(selectedAgentHostClient(), blocks)),
    saveAdmission: (a: AgentHostAdmission) =>
      withSave('admission', () => saveAdmission(selectedAgentHostClient(), a)),
    addRegistration: (u: string) =>
      withSave('servers', () => addRegistration(selectedAgentHostClient(), u)),
    removeRegistration: (u: string) =>
      withSave('servers', () => removeRegistration(selectedAgentHostClient(), u)),
  }
})
