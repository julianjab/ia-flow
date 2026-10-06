import type { Logger } from '@ia-flow/telemetry'
import type { PipelineExecutionContext } from '../pipeline/Runnable.js'
import type { Provider, ProviderRegistry } from './Provider.js'
import type { ProviderCandidate } from './ProviderCandidate.js'

/** Cuánto espera un agente cuyo provider dijo que no puede tomarlo, si no dice cuánto. */
export const DEFAULT_RETRY_AFTER_MS = 30_000

/** El provider elegido para una corrida, con su lugar tomado: `release` lo devuelve. */
export interface SelectedProvider {
  candidate: ProviderCandidate
  provider: Provider
  release: () => void
  /** Los candidatos que se saltearon y por qué (para la traza). */
  skipped: string[]
}

/**
 * Qué provider corre un agente. De sus candidatos (`providers`, o el único `provider`), los
 * elegibles para el evento (su `when`/`whenText`), en orden; de esos, el primero con lugar bajo
 * los topes del agente y del provider (`ctx.limits`) y que acepte (`canAccept`). Si todos están
 * llenos o dicen que no, espera a que se libere un lugar o pase el `retryAfterMs` y vuelve a
 * probar. Con un solo candidato hace cola en él, como siempre.
 *
 * Un candidato comodín (`remote:*`) se resuelve en cada vuelta contra lo registrado en ese momento:
 * los providers que van y vienen (hosts remotos que se suscriben) entran y salen solos. Sin ninguno
 * registrado, el agente espera a que llegue uno — o sigue con el candidato siguiente, si hay.
 *
 * Lo mismo un candidato con nombre de los que van y vienen (`remote:e2e`, ver
 * `ProviderRegistry.expectDynamic`): mientras su host no esté suscrito — el runner recién
 * arrancado, el host reiniciándose — cuenta como ausente, no como un id desconocido.
 */
export class ProviderSelector {
  constructor(
    private readonly agentId: string,
    private readonly maxConcurrent: number | undefined,
    private readonly candidates: ProviderCandidate[],
    private readonly registry: ProviderRegistry,
    private readonly log: Logger,
  ) {}

  /** `prefer`: el provider de una conversación que se retoma — sólo ése, si sigue declarado. */
  async select(ctx: PipelineExecutionContext, prefer?: string): Promise<SelectedProvider> {
    const dynamic = this.candidates.some(
      (candidate) => candidate.wildcard || this.registry.isDynamic(candidate.id),
    )
    // Desde cuándo falta lo que se espera: se reinicia cada vez que vuelve a estar.
    let absentSince = Date.now()
    // La conversación que se retoma en un provider que va y viene: se lo espera (hasta su tope)
    // antes de seguir en otro candidato, que la empezaría de cero.
    let awaitPrefer =
      prefer !== undefined &&
      this.registry.isDynamic(prefer) &&
      this.candidates.some((candidate) => candidate.covers(prefer))
    for (;;) {
      const concrete = this.concrete()
      if (awaitPrefer && prefer && !concrete.some((c) => c.id === prefer)) {
        if (await this.waitFor(prefer, this.registry.dynamicWaitMs(prefer) ?? 0, absentSince)) {
          continue
        }
        this.log.warn(
          `${this.agentId}: ${prefer} no volvió — sigue en otro candidato, sin la conversación`,
        )
        awaitPrefer = false
      }
      if (concrete.length === 0) {
        await this.waitForAny(absentSince)
        continue
      }
      absentSince = Date.now()
      const preferred = prefer ? concrete.filter((c) => c.id === prefer) : []
      const { eligible, skipped } =
        preferred.length > 0
          ? { eligible: preferred, skipped: [] }
          : await this.eligible(ctx, concrete)
      if (!dynamic && eligible.length === 1) {
        return { ...(await this.queueOn(eligible[0] as ProviderCandidate, ctx)), skipped }
      }
      const picked = await this.tryEach(eligible, ctx)
      if ('candidate' in picked) return { ...picked, skipped: [...skipped, ...picked.skipped] }
      this.log.info(
        `${this.agentId}: ningún provider puede tomarlo ahora (${picked.busy.join('; ')})`,
      )
      await Promise.race([
        this.somethingFrees(ctx, picked.retryAfterMs),
        ...(dynamic ? [this.registry.changed()] : []),
      ])
    }
  }

  /** Los candidatos, con cada comodín resuelto contra lo registrado ahora: un id que otro
   *  candidato nombra explícito no se repite, y uno que ya salió no vuelve a salir. Uno con
   *  nombre de los que van y vienen, sin registrar ahora, no sale. */
  private concrete(): ProviderCandidate[] {
    const named = new Set(this.candidates.filter((c) => !c.wildcard).map((c) => c.id))
    const seen = new Set<string>()
    const out: ProviderCandidate[] = []
    for (const candidate of this.candidates) {
      const ids = candidate.wildcard
        ? this.registry
            .list()
            .map((provider) => provider.id)
            .filter((id) => candidate.covers(id) && !named.has(id))
        : this.registry.isDynamic(candidate.id) && !this.registry.resolve(candidate.id)
          ? []
          : [candidate.id]
      for (const id of ids) {
        if (seen.has(id)) continue
        seen.add(id)
        out.push(id === candidate.id ? candidate : candidate.withId(id))
      }
    }
    return out
  }

  /** Hasta que cambie lo registrado, o pase el `DEFAULT_RETRY_AFTER_MS` (o `atMostMs`, si es
   *  menos). */
  private registryChange(atMostMs = DEFAULT_RETRY_AFTER_MS): Promise<void> {
    return Promise.race([
      this.registry.changed(),
      delay(Math.min(atMostMs, DEFAULT_RETRY_AFTER_MS)),
    ])
  }

  /** Sin ningún candidato registrado: espera a que llegue uno — sin tope con un comodín; con el
   *  de los dinámicos con nombre, y pasado ese tope es un error que dice qué no llegó. */
  private async waitForAny(absentSince: number): Promise<void> {
    const ids = this.candidates.map((c) => c.id).join(', ')
    const maxWaitMs = this.namedDynamicWaitMs()
    if (maxWaitMs === undefined) {
      this.log.info(
        `${this.agentId}: ningún provider registrado para ${ids} — espera a que llegue uno`,
      )
      await this.registryChange()
      return
    }
    if (!(await this.waitFor(ids, maxWaitMs, absentSince))) {
      throw new Error(
        `Agent(${this.agentId}): ${ids} no se registró en ${Math.round(maxWaitMs / 60_000)} min — ¿está corriendo y suscrito su host? (¿el nombre está bien escrito?)`,
      )
    }
  }

  /** Espera a que cambie lo registrado, sin pasarse del tope contado desde `since`: `false` si
   *  ya venció. */
  private async waitFor(ids: string, maxWaitMs: number, since: number): Promise<boolean> {
    const left = maxWaitMs - (Date.now() - since)
    if (left <= 0) return false
    this.log.warn(
      `${this.agentId}: ${ids} todavía no está registrado — lo espera ${Math.ceil(left / 1000)} s más`,
    )
    await this.registryChange(left)
    return true
  }

  /** Cuánto esperar cuando no hay ningún candidato registrado: el tope más largo de los
   *  dinámicos con nombre — o `undefined` (sin tope) si hay un comodín, que espera como siempre. */
  private namedDynamicWaitMs(): number | undefined {
    if (this.candidates.some((candidate) => candidate.wildcard)) return undefined
    const waits = this.candidates
      .map((candidate) => this.registry.dynamicWaitMs(candidate.id))
      .filter((ms): ms is number => ms !== undefined)
    return waits.length > 0 ? Math.max(...waits) : undefined
  }

  /** Una vuelta por los elegibles: el primero con lugar que acepta. */
  private async tryEach(
    eligible: ProviderCandidate[],
    ctx: PipelineExecutionContext,
  ): Promise<SelectedProvider | { busy: string[]; retryAfterMs?: number }> {
    const busy: string[] = []
    let retryAfterMs: number | undefined
    for (const candidate of eligible) {
      // Un provider dinámico se pudo ir entre que se resolvió el comodín y ahora.
      const provider = this.registry.resolve(candidate.id)
      if (!provider) {
        busy.push(`${candidate.id}: ya no está registrado`)
        continue
      }
      const release = ctx.limits ? ctx.limits.tryAcquire(this.slots(provider)) : () => {}
      if (!release) {
        busy.push(`${candidate.id}: sin lugar`)
        continue
      }
      const admission = await this.admission(provider, ctx)
      if (admission.accept) return { candidate, provider, release, skipped: busy }
      release()
      busy.push(`${candidate.id}: ${admission.reason}`)
      retryAfterMs = Math.min(retryAfterMs ?? Number.POSITIVE_INFINITY, admission.retryAfterMs)
    }
    return retryAfterMs === undefined ? { busy } : { busy, retryAfterMs }
  }

  /** Los candidatos elegibles para el evento, en orden. Ninguno es un error de definición. */
  private async eligible(
    ctx: PipelineExecutionContext,
    candidates: ProviderCandidate[],
  ): Promise<{ eligible: ProviderCandidate[]; skipped: string[] }> {
    const eligible: ProviderCandidate[] = []
    const skipped: string[] = []
    for (const candidate of candidates) {
      const reason = await candidate.ineligible(ctx)
      if (reason) skipped.push(`${candidate.id}: ${reason}`)
      else eligible.push(candidate)
    }
    if (eligible.length === 0) {
      throw new Error(
        `Agent(${this.agentId}): ningún provider es elegible para este evento — ${skipped.join('; ')}`,
      )
    }
    return { eligible, skipped }
  }

  /** Un solo candidato: hace cola en su lugar y, si no lo acepta, lo suelta y reintenta. */
  private async queueOn(
    candidate: ProviderCandidate,
    ctx: PipelineExecutionContext,
  ): Promise<Omit<SelectedProvider, 'skipped'>> {
    const provider = this.resolve(candidate)
    for (;;) {
      const release = (await ctx.limits?.acquire(this.slots(provider))) ?? (() => {})
      const admission = await this.admission(provider, ctx)
      if (admission.accept) return { candidate, provider, release }
      release()
      this.log.info(
        `${this.agentId}: ${provider.id} no lo toma ahora (${admission.reason}) — reintenta en ${admission.retryAfterMs} ms`,
      )
      await delay(admission.retryAfterMs)
    }
  }

  private resolve(candidate: ProviderCandidate): Provider {
    const provider = this.registry.resolve(candidate.id)
    if (!provider) {
      throw new Error(
        `Agent(${this.agentId}): provider desconocido "${candidate.id}" — ¿lo registraste con providerRegistry.register(...)?`,
      )
    }
    return provider
  }

  private slots(provider: Provider) {
    return [
      { key: `agent:${this.agentId}`, max: this.maxConcurrent },
      { key: `provider:${provider.id}`, max: provider.maxConcurrent },
    ]
  }

  private async admission(
    provider: Provider,
    ctx: PipelineExecutionContext,
  ): Promise<{ accept: true } | { accept: false; reason: string; retryAfterMs: number }> {
    const answer = (await provider.canAccept?.({ agentId: this.agentId, ctx })) ?? {
      accept: true as const,
    }
    if (answer.accept) return answer
    return {
      accept: false,
      reason: answer.reason,
      retryAfterMs: answer.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
    }
  }

  /** Hasta que se libere un lugar (cualquiera) o pase `retryAfterMs` si un provider lo pidió. */
  private somethingFrees(ctx: PipelineExecutionContext, retryAfterMs?: number): Promise<void> {
    const waits: Promise<void>[] = []
    if (ctx.limits) waits.push(ctx.limits.released())
    if (retryAfterMs !== undefined || !ctx.limits) {
      waits.push(delay(retryAfterMs ?? DEFAULT_RETRY_AFTER_MS))
    }
    return Promise.race(waits)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
