import {
  type TunnelStatus,
  type WebhookStatus,
  getTunnelStatus,
  getWebhookStatus,
  startTunnel,
  stopTunnel,
} from '@/features/tunnel/api'
import { defineStore } from 'pinia'

interface State {
  status: TunnelStatus | null
  webhook: WebhookStatus | null
  loading: boolean
  busy: boolean
  error: string | null
}

const STOPPED: TunnelStatus = {
  state: 'stopped',
  url: null,
  webhookUrl: null,
  startedAt: null,
  error: null,
  installed: true,
  recentLog: [],
}

export const useTunnelStore = defineStore('tunnel', {
  state: (): State => ({
    status: null,
    webhook: null,
    loading: false,
    busy: false,
    error: null,
  }),
  getters: {
    current: (s): TunnelStatus => s.status ?? STOPPED,
  },
  actions: {
    apply(status: TunnelStatus) {
      this.status = status
    },
    async fetch() {
      this.loading = true
      try {
        this.status = await getTunnelStatus()
        this.error = null
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Error consultando el túnel'
      } finally {
        this.loading = false
      }
    },
    /** Modo efectivo del daemon por proyecto — no bloquea la tarjeta si falla. */
    async fetchWebhookStatus() {
      try {
        this.webhook = await getWebhookStatus()
      } catch {
        this.webhook = null
      }
    },
    async start() {
      this.busy = true
      this.error = null
      try {
        this.status = await startTunnel()
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Error abriendo el túnel'
      } finally {
        this.busy = false
      }
    },
    async stop() {
      this.busy = true
      this.error = null
      try {
        this.status = await stopTunnel()
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Error cerrando el túnel'
      } finally {
        this.busy = false
      }
    },
  },
})
