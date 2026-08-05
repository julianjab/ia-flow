import type { TechnicalSubTask } from '../../agents/orchestrator.js'

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

export function buildTechnicalSubIssueBody(sub: TechnicalSubTask, parentNumber: number): string {
  const files = sub.files_to_modify
    .map((f) => `- [ ] \`${f.path}\` (${f.change_type}): ${f.description}`)
    .join('\n')

  const scenarios = sub.test_scenarios
    .map((t) => `- [ ] **${t.scenario}**\n  - Given: ${t.given}\n  - When: ${t.when}\n  - Then: ${t.then}`)
    .join('\n')

  const deps = sub.dependencies.length
    ? `\n### Dependencies\n${sub.dependencies.map((d) => `- **${d.repo}**: ${d.what}`).join('\n')}`
    : ''

  const questions = sub.open_questions.length
    ? `\n### ❓ Open Questions\n${sub.open_questions.map((q) => {
        if (typeof q === 'string') return `- ❓ ${q}`
        const opts = q.options.map((o, i) => `  - [ ] ${LETTERS[i]}) ${o}`).join('\n')
        return `- ❓ ${q.question}\n${opts}`
      }).join('\n\n')}`
    : ''

  const api = sub.api_contract
    ? `\n### API Contract\n\`${sub.api_contract.method} ${sub.api_contract.endpoint}\``
    : ''

  const dataModel = sub.data_model_changes
    ? `\n### Data Model Changes\n${sub.data_model_changes}`
    : ''

  const prdSections = [
    api ? api.trimStart() : null,
    dataModel ? dataModel.trimStart() : null,
    `### Files to Modify\n${files}`,
    `### Test Scenarios\n${scenarios}`,
    deps ? deps.trimStart() : null,
    questions ? questions.trimStart() : null,
  ].filter(Boolean).join('\n\n')

  return `> Parent: #${parentNumber}

${sub.description}

---

${prdSections}

<!-- ia-flow:technical -->`
}
