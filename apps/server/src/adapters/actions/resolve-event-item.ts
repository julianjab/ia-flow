import type { IssueItem, ProjectSource, SourceItem } from '@ia-flow/issue-sources'
import { defaultToIssueItem } from '@ia-flow/issue-sources'
import type { EngineEvent } from '@ia-flow/shared'
import { createLogger } from '../../logger.js'

const log = createLogger('action:resolve-item')

/**
 * De un scope de evento al issue del board sobre el que correr un agente.
 *
 * Sólo los eventos del scan (`issue.*`) traen el item en el payload; los de
 * GitHub hablan de un PR o de un commit, y de qué issue cuelgan es justamente
 * lo que hay que averiguar. Este módulo es esa averiguación, y vive en
 * `adapters/` porque su respuesta sale de la fuente.
 *
 * **Es una búsqueda, no una garantía.** Un PR sin issue linkeado no resuelve
 * nada, y eso no es un error: es un PR que nadie pidió desde el board.
 */
export interface ResolveEventItemDeps {
  sourceFor(projectId: string): ProjectSource
}

export function createResolveEventItem(deps: ResolveEventItemDeps) {
  return async function resolveEventItem(
    projectId: string,
    scope: EngineEvent['scope'],
  ): Promise<IssueItem | undefined> {
    const source = deps.sourceFor(projectId)

    // 1. El caso barato: el evento ya nombró el issue. `getItemById` es un
    //    lookup directo, sin listar el board entero.
    if (scope.issueId && source.getItemById) {
      const found = await source.getItemById(scope.issueId)
      if (found) return stamp(found, source, projectId)
      // No cae al escaneo: un issueId que la fuente no conoce es un issue de
      // otro board, no uno que un barrido vaya a encontrar.
      log.debug({ projectId, issueId: scope.issueId }, 'issueId del evento no existe en la fuente')
      return undefined
    }

    // 2. Por número de PR. No hay lookup inverso en el contrato —ninguna
    //    fuente expone "dame el issue de este PR"—, así que se barre lo que el
    //    scan ya tiene cacheado y se busca el PR entre los dev-links de cada
    //    item. Es la misma lista que el dispatch usa en cada ciclo, así que en
    //    la práctica no cuesta una llamada nueva.
    //
    //    Sin `refresh`: si el board todavía no vio el link, el próximo scan lo
    //    va a ver. Forzar un refetch acá pondría a cada delivery de CI —que
    //    llegan de a decenas por push— a pagar una consulta completa del
    //    board.
    if (scope.prNumber != null) {
      const prNumber = scope.prNumber
      const items = await source.getItems()

      // **El número de PR NO es único dentro de un proyecto.** Varios repos
      // mapean al mismo `projectId` y cada uno numera sus PRs desde 1, así que
      // un `#42` de `repo-a` matchearía el issue que linkea el `#42` de
      // `repo-b`. Correrle un agente encima no es un no-op: comenta y
      // transiciona el issue equivocado.
      //
      // `scope.repos` viene resuelto por el traductor del webhook con el
      // MISMO vocabulario que el item (el nombre ia-flow del repo, no
      // owner/repo), así que la intersección es directa.
      const byNumber = items.filter((it) => linksPr(it, prNumber))

      // El filtro por repo se aplica SIEMPRE que el scope lo traiga, no sólo
      // al desempatar. Un único candidato es el caso frecuente y también el
      // peligroso: si el board tiene un solo issue que linkea `repo-a#42` y
      // llega el `#42` de `repo-b`, "hay uno solo" no lo vuelve el correcto.
      //
      // Fail-closed a propósito: un item sin repo declarado (ni campo `Repos`
      // ni `meta.repoName`) no matchea y no corre nada. Correr sobre el issue
      // equivocado deja comentarios y mueve una card que nadie tocó; no correr
      // sólo posterga, porque el scan lo levanta por el camino normal.
      const repos = scope.repos
      const candidates = repos?.length
        ? byNumber.filter((it) => touchesAnyRepo(it, repos))
        : byNumber

      if (candidates.length === 1) return stamp(candidates[0], source, projectId)

      if (candidates.length > 1) {
        log.warn(
          { projectId, prNumber, repos, candidatos: candidates.map((c) => c.id) },
          'más de un issue linkea este PR — ambiguo, no se corre ningún agente',
        )
        return undefined
      }

      // Los dos "no hay ninguno" se loguean distinto: que el issue exista pero
      // sea de otro repo es diagnosticable sólo si el mensaje lo dice.
      if (byNumber.length > 0) {
        log.debug(
          { projectId, prNumber, repos, descartados: byNumber.map((c) => c.id) },
          'el PR matchea por número pero ningún candidato es de los repos del evento',
        )
        return undefined
      }

      log.debug(
        { projectId, prNumber },
        'ningún issue del board linkea este PR — el evento no corre ningún agente',
      )
      return undefined
    }

    return undefined
  }
}

/**
 * `SourceItem` → `IssueItem`, por el mismo camino que usa el scan.
 *
 * La conversión es de la fuente (`toIssueItem`), con el fallback del contrato:
 * escribir una propia acá daría un item con otra forma que el del dispatch —
 * y el agente vería, por ejemplo, `repos` vacío según por qué evento entró.
 *
 * El `projectId` lo estampa normalmente el manager del scan; por este camino
 * no pasa por ahí, y `TaskDispatcher` lo exige (sin él saltea el item).
 */
function stamp(item: SourceItem, source: ProjectSource, projectId: string): IssueItem {
  const converted = source.toIssueItem ? source.toIssueItem(item) : defaultToIssueItem(item)
  return { ...converted, projectId }
}

/** Si un item del board tiene ese PR entre sus dev-links. */
function linksPr(item: SourceItem, prNumber: number): boolean {
  const prs = (item.meta as { pullRequests?: Array<{ number?: number }> } | undefined)?.pullRequests
  return Array.isArray(prs) && prs.some((pr) => pr?.number === prNumber)
}

/**
 * Si el item toca alguno de esos repos.
 *
 * Los dos lugares donde un `SourceItem` los declara, en el orden que usa
 * `defaultToIssueItem`: el campo custom `Repos` (string separado por comas) y,
 * si no hay, el repo que hostea el issue.
 */
function touchesAnyRepo(item: SourceItem, repos: string[]): boolean {
  const fromField = (item.repos ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
  const hostRepo = (item.meta as { repoName?: string } | undefined)?.repoName
  const itemRepos = fromField.length > 0 ? fromField : hostRepo ? [hostRepo] : []
  return itemRepos.some((r) => repos.includes(r))
}
