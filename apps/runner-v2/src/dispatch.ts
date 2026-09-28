/**
 * De `EventArgs` a `DomainEvent` contra el engine montado — lo que comparten la CLI (un evento
 * armado a mano) y el servidor de webhooks (un evento traducido de un delivery de GitHub).
 */
import { createEvent, type DomainEvent } from '@ia-tools/agent-pipeline'
import type { MountedRunner, RunnerProject } from './boot.js'
import { buildPayload, type EventArgs } from './event.js'

/** El proyecto de un repo: el que lo declara en su catálogo, o el único montado. */
export function projectFor(mounted: MountedRunner, repo: string): RunnerProject | undefined {
  const declared = mounted.repos.find((r) => r.githubRepo === repo || r.name === repo)
  const byRepo = mounted.projects.find((p) => p.id === declared?.projectId)
  return byRepo ?? (mounted.projects.length === 1 ? mounted.projects[0] : undefined)
}

/** Arma el `DomainEvent` de `args` en el scope de `project` (lee el issue, salvo en dry-run). */
export async function toDomainEvent(
  project: RunnerProject,
  args: EventArgs,
  dryRun: boolean,
): Promise<DomainEvent> {
  const projectRepos = project.repos
    .map(
      (repo) =>
        `- ${repo.name} (${repo.githubOwner}/${repo.githubRepo}): ${repo.description ?? ''}`,
    )
    .join('\n')
  const client = dryRun ? undefined : project.actions.client
  const payload = await buildPayload(args, client, {
    repos: projectRepos,
    branchPrefix: project.branchPrefix,
  })
  // El scope es lo que se filtra en la telemetría: cada span y log hereda `ia.projectId`,
  // `ia.repo`, `ia.issue` (ver la telemetría de `@ia-tools/agent-pipeline`).
  const repo = `${args.owner}/${args.repo}`
  return createEvent(args.eventType, payload, {
    scope: {
      projectId: project.id,
      repo,
      issue: `${repo}#${args.number}`,
      ...(args.pr ? { pr: `${repo}#${args.pr}` } : {}),
    },
  })
}
