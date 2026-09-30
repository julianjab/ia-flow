/**
 * De un `slack.message` a la task a la que contesta — el `locate` de Slack. Sólo cuenta la
 * RESPUESTA dentro de un hilo que abrió el bot con un pedido de review (`request_slack_review`):
 * el mensaje raíz trae el issue (`owner/repo#N`) y la URL del PR — la acción se asegura de
 * escribirlos siempre —, así que la task sale del propio hilo. Si falta el issue, `resolve_task`
 * llega a él por el PR, igual que con el comentario de un PR. Se lee el hilo en vez de buscar el
 * link en los issues porque la búsqueda de GitHub llega tarde (un índice con minutos de retraso) y
 * esto es determinista: sin modelo, sin costo y sin errores de interpretación.
 *
 * La respuesta se vuelve un `issue_comment`: desde ahí la atienden las mismas pipelines que un
 * comentario humano en GitHub (`50-comment.yaml`: el gate `whenText`, la columna, `ifQueued`, los
 * `injects` del agente que ya corre), sin una pipeline aparte.
 */
import { githubLoginOf, type SlackUserDirectory } from '@ia-flow/slack-api'
import type { Location } from './locate.js'

type Raw = Record<string, unknown>

/** Lo que necesita de Slack: el mensaje raíz de un hilo, su link y el nombre de alguien. */
export interface SlackThreadPort {
  /** El mensaje que abrió el hilo; `fromBot`: lo publicó el bot (no una persona). */
  rootOf(channel: string, threadTs: string): Promise<{ text: string; fromBot: boolean } | undefined>
  permalink(channel: string, ts: string): Promise<string>
  userName(userId: string): Promise<string>
}

export interface SlackLocateDeps {
  threads: SlackThreadPort
  /** `slack.users` de runner.yaml: login de GitHub → usuario de Slack. */
  users?: SlackUserDirectory
}

const PR_URL = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/
const ISSUE_REF = /(?<![\w/.-])([\w.-]+)\/([\w.-]+)#(\d+)/

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/** Lo que se le dice al agente para que conteste donde se lo pidieron: va en `{{replyInstructions}}`
 *  de los briefs de `50-comment.yaml` (vacío para un comentario de GitHub). */
export function replyInstructions(channel: string, thread: string): string {
  return `Este pedido llegó por Slack, en el hilo ${thread}. Al terminar, contestá en ese hilo con \`slack_post_message\` (channel: \`${channel}\`, thread: \`${thread}\`) contando qué cambiaste, o por qué no pudiste.`
}

export async function locateSlack(raw: Raw, deps: SlackLocateDeps): Promise<Location> {
  const channel = text(raw.channel)
  const threadTs = text(raw.threadTs)
  const ts = text(raw.ts)
  const author = text(raw.author)
  const body = text(raw.text)
  if (raw.isThreadReply !== true || !channel || !threadTs || !ts || !author || !body) {
    return { skip: 'slack.message no es la respuesta de un hilo' }
  }
  const root = await deps.threads.rootOf(channel, threadTs)
  if (!root?.fromBot) return { skip: 'el hilo no es un pedido del bot' }
  const pr = PR_URL.exec(root.text)
  const issue = ISSUE_REF.exec(root.text)
  if (!pr && !issue) return { skip: 'el mensaje que abrió el hilo no trae un issue ni un PR' }
  // El repo sale del issue o, sin él, del PR.
  const [, owner, repo] = (issue ?? pr) as unknown as [string, string, string]
  const prNumber = pr ? Number(pr[3]) : undefined
  const thread = await deps.threads.permalink(channel, threadTs)
  const name = githubLoginOf(author, deps.users) ?? (await deps.threads.userName(author))
  return {
    owner,
    repo,
    // Con el issue en el hilo, ya está; si no, el PR dice cuál implementa (rama o `Closes #n`).
    ...(issue ? { number: Number(issue[3]) } : {}),
    ...(prNumber !== undefined ? { pr: prNumber } : {}),
    ...(!issue && prNumber !== undefined ? { inspect: prNumber } : {}),
    emit: 'issue_comment',
    extra: {
      action: 'created',
      source: 'slack',
      slack: { channel, threadTs, thread },
      replyInstructions: replyInstructions(channel, thread),
    },
    comment: { body, author: name, id: Number(ts.replace('.', '')) },
  }
}
