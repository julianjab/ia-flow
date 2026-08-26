// Qué servers ia-flow hay a la vista y cuál está mirando esta web.
//
// La lista se APRENDE: el barrido de puertos corre una sola vez (la primera
// visita, cuando no sabemos nada) y lo que encuentra queda recordado. Las
// cargas siguientes sondean sólo los conocidos.
//
// El motivo es concreto: un sondeo fallido desde el browser deja un
// ERR_CONNECTION_REFUSED rojo en la consola que NO se puede atrapar — barrer
// 17 puertos en cada carga llenaba la consola de ruido y enterraba los
// errores de verdad.

import { type ProbedServer, normalizeBaseUrl, probeServer } from '@/features/servers/api'
import { currentBaseUrl } from '@/features/servers/selection'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

const KNOWN_KEY = 'ia-flow:servers:known'
const PINNED_KEY = 'ia-flow:servers:pinned'

// Puertos del barrido: 3001 (dev:server) y el rango donde caen los deploys/*
// publicados al host (ver deploys/*/docker-compose.yml).
const SWEEP_PORTS = [3001, ...Array.from({ length: 16 }, (_, i) => 3010 + i)]

function load(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : []
  } catch {
    return []
  }
}

function save(key: string, urls: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(urls))
  } catch {
    /* modo privado / storage lleno — la lista sigue viva en memoria */
  }
}

export const useServersStore = defineStore('servers', () => {
  const servers = ref<ProbedServer[]>([])
  // Conocidos = los que alguna vez respondieron. Los pineados son un
  // subconjunto: los que agregó el usuario y por eso se muestran aunque estén
  // caídos (y se pueden quitar).
  const knownUrls = ref<string[]>(load(KNOWN_KEY))
  const pinnedUrls = ref<string[]>(load(PINNED_KEY))
  const scanning = ref(false)
  const lastScanAt = ref<number | null>(null)

  const reachable = computed(() => servers.value.filter((s) => s.reachable))
  /** Primera visita: no aprendimos nada todavía, hay que barrer. */
  const neverSwept = computed(() => knownUrls.value.length === 0)

  function remember(urls: string[]): void {
    const next = [...new Set([...knownUrls.value, ...urls])]
    knownUrls.value = next
    save(KNOWN_KEY, next)
  }

  async function probeAll(urls: string[]): Promise<ProbedServer[]> {
    const probed = await Promise.all([...new Set(urls)].filter(Boolean).map(probeServer))
    remember(probed.filter((s) => s.reachable).map((s) => s.baseUrl))
    // Un caído se muestra sólo si es el actual o si lo pineó el usuario: los
    // demás son corazonadas del barrido, y listarlos en rojo inventaría una
    // docena de servers que nunca existieron.
    return probed.filter(
      (s) => s.reachable || s.baseUrl === currentBaseUrl() || pinnedUrls.value.includes(s.baseUrl),
    )
  }

  /** Sondea lo que ya conocemos. En la primera visita barre puertos primero. */
  async function scan(): Promise<void> {
    if (scanning.value) return
    if (neverSwept.value) return sweepPorts()
    scanning.value = true
    try {
      servers.value = await probeAll([currentBaseUrl(), ...knownUrls.value, ...pinnedUrls.value])
      lastScanAt.value = Date.now()
    } finally {
      scanning.value = false
    }
  }

  /** El barrido explícito: caro y ruidoso, por eso no corre en cada carga. */
  async function sweepPorts(): Promise<void> {
    if (scanning.value) return
    scanning.value = true
    try {
      const sweep = SWEEP_PORTS.map((p) => `http://localhost:${p}`)
      servers.value = await probeAll([
        currentBaseUrl(),
        ...knownUrls.value,
        ...pinnedUrls.value,
        ...sweep,
      ])
      lastScanAt.value = Date.now()
      // Deja marcado que ya barrimos aunque no haya aparecido nada, para no
      // repetir el barrido ruidoso en cada carga.
      remember([currentBaseUrl()])
    } finally {
      scanning.value = false
    }
  }

  async function addUrl(raw: string): Promise<void> {
    const url = normalizeBaseUrl(raw)
    if (!url || pinnedUrls.value.includes(url)) return
    pinnedUrls.value = [...pinnedUrls.value, url]
    save(PINNED_KEY, pinnedUrls.value)
    servers.value = [...servers.value.filter((s) => s.baseUrl !== url), await probeServer(url)]
  }

  function removeUrl(url: string): void {
    pinnedUrls.value = pinnedUrls.value.filter((u) => u !== url)
    save(PINNED_KEY, pinnedUrls.value)
    knownUrls.value = knownUrls.value.filter((u) => u !== url)
    save(KNOWN_KEY, knownUrls.value)
    servers.value = servers.value.filter((s) => s.baseUrl !== url || s.baseUrl === currentBaseUrl())
  }

  return {
    servers,
    knownUrls,
    pinnedUrls,
    scanning,
    lastScanAt,
    reachable,
    neverSwept,
    scan,
    sweepPorts,
    addUrl,
    removeUrl,
  }
})
