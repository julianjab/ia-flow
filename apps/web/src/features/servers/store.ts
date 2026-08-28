// Qué servers hay declarados y cuál está mirando esta web.
//
// La lista es CONFIG, no un descubrimiento: agregás un server, queda guardado
// (en el config dir de la app de escritorio, o en localStorage en un browser —
// ver storage.ts) y la app sondea exactamente esos.
//
// Antes barría 17 puertos de localhost la primera vez y "aprendía" lo que
// respondiera. Se sacó por tres motivos, y el tercero es el que decide: sólo
// encontraba servers locales, cada sondeo fallido dejaba un
// ERR_CONNECTION_REFUSED rojo e inatrapable en la consola, y **adivinaba** —
// cualquier cosa escuchando en :3014 entraba a la lista como si fuera un
// server de ia-flow.

import { type ProbedServer, normalizeBaseUrl, probeServer } from '@/features/servers/api'
import { applySelectedToken, currentBaseUrl, getSelectedServer } from '@/features/servers/selection'
import { type SavedServer, loadServers, saveServers } from '@/features/servers/storage'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export const useServersStore = defineStore('servers', () => {
  /** Lo declarado — la fuente de verdad. */
  const saved = ref<SavedServer[]>([])
  /** El resultado del último sondeo, uno por server declarado. */
  const servers = ref<ProbedServer[]>([])
  const scanning = ref(false)
  const loaded = ref(false)
  const lastScanAt = ref<number | null>(null)

  const reachable = computed(() => servers.value.filter((s) => s.reachable))
  /** Nada declarado todavía: la pantalla muestra el alta en vez de una lista vacía. */
  const empty = computed(() => loaded.value && saved.value.length === 0)

  function tokenFor(baseUrl: string): string | undefined {
    return saved.value.find((s) => s.baseUrl === baseUrl)?.token
  }

  async function persist(): Promise<void> {
    await saveServers(saved.value)
  }

  /**
   * Carga la lista y sondea. Se llama una vez al entrar a la pantalla.
   *
   * Re-aplica el token del server ya elegido: `restoreSelectedServer()` corre
   * antes de montar la app y sólo restaura la URL, porque la lista puede venir
   * del disco por IPC y eso es asíncrono.
   */
  async function init(): Promise<void> {
    if (loaded.value) return
    saved.value = await loadServers()
    loaded.value = true
    const current = getSelectedServer()
    if (current) applySelectedToken(tokenFor(current))
    await scan()
  }

  /** Sondea lo declarado. Cada uno con SU token. */
  async function scan(): Promise<void> {
    if (scanning.value) return
    scanning.value = true
    try {
      servers.value = await Promise.all(saved.value.map((s) => probeServer(s.baseUrl, s.token)))
      lastScanAt.value = Date.now()
    } finally {
      scanning.value = false
    }
  }

  /**
   * Agrega un server. Devuelve `false` si ya estaba — la baseUrl es la
   * identidad, y dos entradas iguales dejarían al usuario editando una y
   * viendo la otra.
   */
  async function addServer(raw: string, token?: string, label?: string): Promise<boolean> {
    const baseUrl = normalizeBaseUrl(raw)
    if (!baseUrl || saved.value.some((s) => s.baseUrl === baseUrl)) return false
    saved.value = [
      ...saved.value,
      { baseUrl, ...(token ? { token } : {}), ...(label ? { label } : {}) },
    ]
    await persist()
    // Sólo el nuevo, no toda la lista: sondear los demás de nuevo no aporta y
    // hace parpadear la pantalla entera.
    servers.value = [...servers.value, await probeServer(baseUrl, token)]
    return true
  }

  /**
   * Cambia el token (o la etiqueta) de un server y lo vuelve a sondear.
   *
   * Re-aplica el header si es el server que estás mirando: sin eso, corregir
   * el token dejaría la pantalla en verde pero las requests reales seguirían
   * saliendo con el viejo hasta recargar.
   */
  async function updateServer(baseUrl: string, patch: Partial<SavedServer>): Promise<void> {
    saved.value = saved.value.map((s) => (s.baseUrl === baseUrl ? { ...s, ...patch } : s))
    await persist()
    if (getSelectedServer() === baseUrl) applySelectedToken(tokenFor(baseUrl))
    const probed = await probeServer(baseUrl, tokenFor(baseUrl))
    servers.value = servers.value.map((s) => (s.baseUrl === baseUrl ? probed : s))
  }

  /** Quita un server. El que estás mirando NO se puede quitar. */
  async function removeServer(baseUrl: string): Promise<void> {
    if (currentBaseUrl() === baseUrl) return
    saved.value = saved.value.filter((s) => s.baseUrl !== baseUrl)
    await persist()
    servers.value = servers.value.filter((s) => s.baseUrl !== baseUrl)
  }

  return {
    saved,
    servers,
    scanning,
    loaded,
    lastScanAt,
    reachable,
    empty,
    tokenFor,
    init,
    scan,
    addServer,
    updateServer,
    removeServer,
  }
})
