/**
 * Los comentarios que llegan mientras la task no es de este runner —típicamente con `blocked`
 * puesto: el `when` del intake la descarta— no los ve nadie: ni una pipeline, ni el agente que
 * corre, ni una pipeline después (ia-flow#331). Al destrabarla, el intake los vuelve a publicar.
 * Acá, cuáles: los de una persona, posteriores a cuando se puso el label que la trababa, y que no
 * haya publicado el propio runner en nombre de alguien (`UserCommentLedger`).
 */
import type { RawComment } from '@ia-flow/github-tools'

/** La marca de lo que publica el engine (reportes, avisos): eso no es un pedido humano. */
const ENGINE_MARK = '<!-- ia-flow:'

/** Si `author` es una persona: no una App (`<algo>[bot]`) ni una cuenta de tipo `Bot`. */
export function isHumanAuthor(author: string | undefined, type?: string): boolean {
  return Boolean(author) && type !== 'Bot' && !author?.endsWith('[bot]')
}

/** Si un comentario es un pedido de una persona: autor humano y sin la marca del engine. */
export function isHumanComment(body: string | null | undefined, author?: string, type?: string) {
  return isHumanAuthor(author, type) && !(body ?? '').includes(ENGINE_MARK)
}

/**
 * Los comentarios que el runner publicó a nombre de una persona (`post_user_comment`, "Responder y
 * destrabar" de la bandeja), por un rato. Ésos ya los atiende la acción que los publicó —devuelve
 * la tarea a su etapa, y esa etapa lee la respuesta en `task.comments`—: volver a publicarlos al
 * destrabar la card dispararía el pipeline de comentarios además. En memoria: la acción y el
 * destrabe pasan con segundos de diferencia, en el mismo proceso.
 */
export class UserCommentLedger {
  private readonly posted = new Map<number, number>()

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  note(commentId: number): void {
    this.prune()
    this.posted.set(commentId, this.now())
  }

  has(commentId: number): boolean {
    this.prune()
    return this.posted.has(commentId)
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs
    for (const [id, at] of this.posted) if (at < cutoff) this.posted.delete(id)
  }
}

/** Un comentario retenido, con el PR donde se escribió si no fue en el issue. */
export interface HeldComment {
  id: number
  body: string
  author: string
  createdAt: string
  pr?: number
}

/**
 * Los comentarios humanos escritos desde `since` (cuando se trabó la task), en orden, sin los que
 * el runner publicó a nombre de alguien. Los del PR llevan su número.
 */
export function heldComments(
  sources: Array<{ comments: RawComment[]; pr?: number }>,
  since: string,
  postedByRunner: (commentId: number) => boolean,
): HeldComment[] {
  const held = (comment: RawComment): comment is RawComment & { id: number } =>
    comment.id !== undefined &&
    comment.created_at > since &&
    isHumanComment(comment.body, comment.user?.login, comment.user?.type) &&
    !postedByRunner(comment.id)
  return sources
    .flatMap(({ comments, pr }) =>
      comments.filter(held).map((comment) => ({
        id: comment.id,
        body: comment.body ?? '',
        author: comment.user?.login ?? '',
        createdAt: comment.created_at,
        ...(pr !== undefined ? { pr } : {}),
      })),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
