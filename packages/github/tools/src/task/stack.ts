/**
 * Una task que avanza sobre prerrequisitos ya construidos (sin esperar su merge): qué la sigue
 * frenando y, si alguno es del mismo repo, de qué rama sale la suya (un PR apilado). Puro: los PRs
 * de los blockers los lee quien llama.
 *
 * - Un blocker con PR abierto está construido: no frena. Si es de OTRO repo, la task se construye
 *   contra el contrato (su PRD); si es del MISMO, sobre su rama.
 * - Un blocker sin PR abierto frena: no hay nada sobre qué construir.
 * - Los blockers del mismo repo tienen que formar una cadena (cada PR apilado sobre el anterior):
 *   la rama sale de la punta y trae a todos. Dos ramas independientes no se pueden apilar a la vez,
 *   así que frenan todos los del repo hasta que se mergee alguno.
 */

/** Un blocker abierto de la task, con su PR abierto si tiene uno. */
export interface StackBlocker {
  owner: string
  repo: string
  number: number
  pr?: { number: number; headRef: string; baseRef: string }
}

/** La rama de un prerrequisito del mismo repo sobre la que sale la de la task. */
export interface StackBase {
  /** La rama (`headRef` del PR del prerrequisito): la base del PR de la task. */
  branch: string
  pr: number
  /** `owner/repo#n` del prerrequisito. */
  issue: string
}

export interface Stack {
  /** Los blockers que todavía frenan (`owner/repo#n`). */
  pending: string[]
  base?: StackBase
}

const refOf = (blocker: StackBlocker) => `${blocker.owner}/${blocker.repo}#${blocker.number}`
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export function stackOf(task: { owner: string; repo: string }, blockers: StackBlocker[]): Stack {
  const pending = blockers.filter((blocker) => !blocker.pr).map(refOf)
  const local = blockers.filter(
    (blocker): blocker is StackBlocker & { pr: NonNullable<StackBlocker['pr']> } =>
      blocker.pr !== undefined && same(blocker.owner, task.owner) && same(blocker.repo, task.repo),
  )
  if (local.length === 0) return { pending }
  const byHead = new Map(local.map((blocker) => [blocker.pr.headRef, blocker]))
  // La punta: la rama sobre la que no se apila ningún otro de la cadena.
  const tips = local.filter((blocker) => !local.some((o) => o.pr.baseRef === blocker.pr.headRef))
  const tip = tips.length === 1 ? tips[0] : undefined
  const chain = new Set<StackBlocker>()
  for (let at = tip; at && !chain.has(at); at = byHead.get(at.pr.baseRef)) chain.add(at)
  if (!tip || chain.size !== local.length) return { pending: [...pending, ...local.map(refOf)] }
  return { pending, base: { branch: tip.pr.headRef, pr: tip.pr.number, issue: refOf(tip) } }
}
