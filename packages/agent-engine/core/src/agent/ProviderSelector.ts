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
          ? { eligible: [await this.firstEligible(ctx, preferred)], skipped: [] }
          : await this.eligible(ctx, concrete)
      if (!dynamic && eligible.length === 1) {
        return { ...(await this.queueOn(eligible[0] as ProviderCandidate, ctx)), skipped }
      }
      const picked = await this.tryEach(eligible, ctx)
      if ('candidate' in picked) {
        const absent = this.absentBefore(picked.candidate)
        return { ...picked, skipped: [...skipped, ...picked.skipped, ...absent] }
      }
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
   *  candidato nombra explícito no sale del comodín. Uno con nombre de los que van y vienen, sin
   *  registrar ahora, no sale. Un mismo id puede salir de varios candidatos (cada uno con su
   *  `when` y su config): de esos corre el primero elegible (ver `eligible`). */
  private concrete(): ProviderCandidate[] {
    const named = new Set(this.candidates.filter((c) => !c.wildcard).map((c) => c.id))
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
      for (const id of ids) out.push(id === candidate.id ? candidate : candidate.withId(id))
    }
    return out
  }

  /**
   * Lo que el agente prefería y no estaba registrado — un `remote:*` o un `remote:<host>` antes
   * del candidato elegido —, para la traza: `concrete()` los deja afuera sin decir nada, así que
   * un `remote:*` que caía a la API sólo nombraba a los hosts que dijeron que no, nunca al que
   * faltaba (lh-seller-v2-frontend#4470: `remote:front-end-developer` redesplegándose).
   */
  private absentBefore(picked: ProviderCandidate): string[] {
    const index = this.candidates.findIndex((candidate) => candidate.covers(picked.id))
    const preferred = this.candidates.slice(0, index === -1 ? 0 : index)
    const notes: string[] = []
    for (const candidate of preferred) {
      if (!candidate.wildcard && !this.registry.isDynamic(candidate.id)) continue
      if (!candidate.wildcard && this.registry.resolve(candidate.id)) continue
      const gone = this.registry
        .departed()
        .filter(({ id }) => candidate.covers(id) && !this.registry.resolve(id))
        .map(({ id, at }) => `${id}: no está suscrito (se fue hace ${ago(Date.now() - at)})`)
      if (gone.length > 0) notes.push(...gone)
      else if (candidate.wildcard) notes.push(`${candidate.id}: ${this.subscribedUnder(candidate)}`)
      else notes.push(`${candidate.id}: no está suscrito`)
    }
    return notes
  }

  /** Para la traza de un comodín sin hosts que falten: quiénes había (los que dijeron que no ya
   *  están en el motivo) o que no había ninguno. */
  private subscribedUnder(wildcard: ProviderCandidate): string {
    const here = this.registry
      .list()
      .map((provider) => provider.id)
      .filter((id) => wildcard.covers(id))
    return here.length > 0
      ? `ningún otro host suscrito (sólo ${here.join(', ')})`
      : 'ningún host suscrito'
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

  /** Los candidatos elegibles para el evento, en orden y uno por provider: el primero elegible
   *  de los que lo nombran (`anthropic-api` con `when` para las tareas chicas y un modelo
   *  barato, y después `anthropic-api` para el resto). Ninguno es un error de definición. */
  private async eligible(
    ctx: PipelineExecutionContext,
    candidates: ProviderCandidate[],
  ): Promise<{ eligible: ProviderCandidate[]; skipped: string[] }> {
    const eligible: ProviderCandidate[] = []
    const skipped: string[] = []
    const taken = new Set<string>()
    for (const candidate of candidates) {
      if (taken.has(candidate.id)) continue
      const reason = await candidate.ineligible(ctx)
      if (reason) {
        skipped.push(`${candidate.id}: ${reason}`)
        continue
      }
      taken.add(candidate.id)
      eligible.push(candidate)
    }
    if (eligible.length === 0) {
      throw new Error(
        `Agent(${this.agentId}): ningún provider es elegible para este evento — ${skipped.join('; ')}`,
      )
    }
    return { eligible, skipped }
  }

  /** La conversación que se retoma sigue en su provider aunque su `when` ya no pase; si varios
   *  candidatos lo nombran, con la config del primero elegible. */
  private async firstEligible(
    ctx: PipelineExecutionContext,
    preferred: ProviderCandidate[],
  ): Promise<ProviderCandidate> {
    if (preferred.length === 1) return preferred[0] as ProviderCandidate
    for (const candidate of preferred) {
      if (!(await candidate.ineligible(ctx))) return candidate
    }
    return preferred[0] as ProviderCandidate
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

/** `45 s`, `12 min`, `3 h`: cuánto hace, para leer en una traza. */
function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
