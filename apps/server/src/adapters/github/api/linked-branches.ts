// Adapter para el feature "Development panel → Create a branch" de GitHub
// (linkedBranches). Expone dos operaciones:
//
//   • getPrimaryLinkedBranch(issueNodeId, primaryRepoName) → nombre de la branch
//     ya linkeada al issue (si la hay), preferentemente la que pertenece al
//     repo primario de la task.
//   • createLinkedBranch(issueNodeId, name, repoOwner, repoName) → crea la branch
//     desde el HEAD de `main` (o el default branch del repo) y la linkea al issue.
//     Idempotente: si GitHub responde con conflicto porque ya existe una branch
//     con ese nombre, hacemos best-effort refetch del linkedBranch existente.
//
// El nombre lo elige quien invoque (típicamente `proposeLinkedBranchName` que
// consulta Claude Haiku). Este módulo NO conoce política de naming — solo I/O.

import { createLogger } from '../../../logger.js'
import { gql } from './client.js'

const log = createLogger('github-linked-branches')

interface LinkedBranchNode {
  ref?: { name?: string; repository?: { name?: string } } | null
}

/**
 * Devuelve la branch linkeada al issue. Preferimos la del `primaryRepoName`
 * cuando el issue tiene varias; si no matchea ninguna, la primera; si no hay,
 * `null`.
 */
export async function getPrimaryLinkedBranch(
  issueNodeId: string,
  primaryRepoName: string | undefined,
): Promise<string | null> {
  const data = await gql<{
    node?: { linkedBranches?: { nodes?: LinkedBranchNode[] } } | null
  }>(
    `query($id: ID!) {
      node(id: $id) {
        ... on Issue {
          linkedBranches(first: 5) {
            nodes {
              ref { name repository { name } }
            }
          }
        }
      }
    }`,
    { id: issueNodeId },
  )
  const nodes = data?.node?.linkedBranches?.nodes ?? []
  if (!nodes.length) return null
  const match = primaryRepoName
    ? nodes.find((n) => n.ref?.repository?.name === primaryRepoName)
    : null
  return (match ?? nodes[0])?.ref?.name ?? null
}

/**
 * Resuelve `{ repositoryId, oid }` para el HEAD de la default branch del repo
 * (`main` / `master` / lo que sea). Necesario porque `createLinkedBranch` pide
 * el SHA exacto sobre el que basar la branch.
 */
async function resolveRepoHead(
  owner: string,
  repo: string,
): Promise<{ repositoryId: string; oid: string; defaultBranch: string }> {
  const data = await gql<{
    repository?: {
      id: string
      defaultBranchRef?: { name: string; target?: { oid: string } | null } | null
    } | null
  }>(
    `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        id
        defaultBranchRef {
          name
          target { ... on Commit { oid } }
        }
      }
    }`,
    { owner, name: repo },
  )
  const repository = data?.repository
  const oid = repository?.defaultBranchRef?.target?.oid
  const defaultBranch = repository?.defaultBranchRef?.name
  if (!repository?.id || !oid || !defaultBranch) {
    throw new Error(
      `Cannot resolve default branch HEAD for ${owner}/${repo} (missing repo id or HEAD SHA)`,
    )
  }
  return { repositoryId: repository.id, oid, defaultBranch }
}

export interface CreateLinkedBranchResult {
  name: string
  created: boolean
}

/**
 * Crea la branch en el repo y la linkea al issue. Idempotente en la práctica:
 * si la branch ya existe / ya está linkeada, capturamos el error, releemos, y
 * devolvemos el nombre existente con `created: false`.
 */
export async function createLinkedBranch(
  issueNodeId: string,
  name: string,
  repoOwner: string,
  repoName: string,
): Promise<CreateLinkedBranchResult> {
  const { repositoryId, oid, defaultBranch } = await resolveRepoHead(repoOwner, repoName)
  try {
    const data = await gql<{
      createLinkedBranch?: { linkedBranch?: { ref?: { name?: string } | null } | null } | null
    }>(
      `mutation($issueId: ID!, $name: String!, $oid: GitObjectID!, $repositoryId: ID!) {
        createLinkedBranch(input: {
          issueId: $issueId
          name: $name
          oid: $oid
          repositoryId: $repositoryId
        }) {
          linkedBranch {
            ref { name }
          }
        }
      }`,
      { issueId: issueNodeId, name, oid, repositoryId },
    )
    const created = data?.createLinkedBranch?.linkedBranch?.ref?.name ?? name
    log.info({ issueNodeId, name: created, defaultBranch, oid }, 'linked branch created')
    return { name: created, created: true }
  } catch (err) {
    // Ya existe: releemos, si hay linked branch la devolvemos.
    log.warn(
      { err, issueNodeId, name },
      'createLinkedBranch failed — trying to reuse existing linkedBranch',
    )
    const existing = await getPrimaryLinkedBranch(issueNodeId, repoName)
    if (existing) return { name: existing, created: false }
    throw err
  }
}
