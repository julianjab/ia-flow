import type { ImprovementProposal } from '@ia-flow/shared'

export function proposal(over: Partial<ImprovementProposal> = {}): ImprovementProposal {
  return {
    id: 'imp-1',
    created_at: '2026-10-01T10:00:00.000Z',
    task_ref: 'acme/api#7',
    pr_url: 'https://github.com/acme/api/pull/9',
    agent: 'retrospective',
    target: 'docs',
    repo: 'acme/api',
    title: 'Documentar el comando de tests',
    body: '## Problema\nNadie sabe cómo correr los tests.',
    labels: ['docs'],
    reason: 'el agente adivinó el comando tres veces',
    status: 'open',
    ...over,
  }
}
