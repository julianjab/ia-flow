import type { MemberVerdict, ParallelGroup } from './ParallelGroup.js'
import type { PipelineExecutionContext, Runnable, StepResume } from './Runnable.js'

/**
 * Por dónde va un grupo `parallel`, para retomarlo si el proceso muere mientras corre: por
 * miembro, la conversación que guardó (`state`) o el veredicto con el que ya terminó (`verdict`).
 * Sin esto el grupo no guardaba nada — el checkpoint es del paso de `do[]` (el grupo), y cada
 * miembro guarda como él mismo — y un reinicio dejaba la ejecución `failed` (subscriptions#1918:
 * dos reviews perdidos, relanzados a mano).
 */
export interface GroupProgress {
  members: Record<string, MemberProgress>
}

export type MemberProgress = { state: unknown } | { verdict: MemberVerdict }

/** Lo que se lleva cada miembro al correr: su `ctx`, o el veredicto que ya tenía. */
export type MemberStart =
  | { kind: 'run'; ctx: PipelineExecutionContext }
  | { kind: 'done'; verdict: MemberVerdict }

/**
 * Guarda el progreso de un grupo mientras corre: lo ancla al arrancar (para que un reinicio antes
 * de que ningún miembro guarde también se retome), anota lo de cada miembro, y lo borra al
 * terminar. Al retomar, arranca desde lo que había guardado.
 */
export class GroupProgressTracker {
  private readonly progress: GroupProgress
  private readonly resumed: StepResume | undefined

  constructor(
    private readonly group: ParallelGroup,
    private readonly ctx: PipelineExecutionContext,
  ) {
    this.resumed = ctx.resume?.step === group.id ? ctx.resume : undefined
    this.progress = { members: { ...asGroupProgress(this.resumed?.state)?.members } }
  }

  /** Ancla el grupo: desde acá, un reinicio lo retoma. */
  start(): void {
    this.save()
  }

  /** Terminó (bien o mal): no queda nada que retomar. */
  finish(): void {
    this.ctx.saveProgress?.(this.group, undefined)
  }

  /** El miembro terminó con este veredicto: al retomar no se vuelve a correr. */
  done(member: Runnable, verdict: MemberVerdict): void {
    if (member.id === undefined) return
    this.progress.members[member.id] = { verdict }
    this.save()
  }

  /** Cómo arranca `member`: con el veredicto que ya tenía, o con su `ctx` — que guarda su
   *  conversación en el grupo y, si se retoma, sigue la suya con el aviso de qué pasó. */
  begin(member: Runnable): MemberStart {
    const id = member.id
    const saved = id === undefined ? undefined : this.progress.members[id]
    if (saved && 'verdict' in saved) return { kind: 'done', verdict: saved.verdict }
    const ctx: PipelineExecutionContext = {
      ...this.ctx,
      ...(id !== undefined ? { lane: id } : {}),
      saveProgress: (from, state) => {
        if (from !== member || id === undefined) return
        if (state === undefined) delete this.progress.members[id]
        else this.progress.members[id] = { state }
        this.save()
      },
    }
    if (this.resumed && id !== undefined) {
      ctx.resume = {
        ...this.resumed,
        step: id,
        state: saved && 'state' in saved ? saved.state : undefined,
      }
    } else {
      delete ctx.resume
    }
    return { kind: 'run', ctx }
  }

  private save(): void {
    this.ctx.saveProgress?.(this.group, this.progress)
  }
}

function asGroupProgress(state: unknown): GroupProgress | undefined {
  if (typeof state !== 'object' || state === null) return undefined
  const members = (state as { members?: unknown }).members
  return typeof members === 'object' && members !== null ? (state as GroupProgress) : undefined
}
