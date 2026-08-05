// PRD-related helpers — pure functions extracted from daemon-github.ts

export function buildRefinedBody(original: string, prdMarkdown: string): string {
  return `${original.trim()}\n\n---\n\n${prdMarkdown}`
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

function renderQuestion(q: any, indent = ''): string {
  if (typeof q === 'string') return `${indent}- ❓ ${q}`
  // Multiple choice
  const opts = (q.options ?? [])
    .map((opt: string, i: number) => `${indent}  - [ ] ${LETTERS[i]}) ${opt}`)
    .join('\n')
  return `${indent}- ❓ ${q.question}\n${opts}`
}

// Parse checkbox answers from a rendered PRD body
// Returns: [{ question, selected: ["option text"] }]
export function parseCheckboxAnswers(body: string): Array<{ question: string; selected: string[] }> {
  const results: Array<{ question: string; selected: string[] }> = []
  const lines = body.split('\n')

  let currentQuestion: string | null = null
  let selected: string[] = []

  for (const line of lines) {
    const questionMatch = line.match(/[-*]\s+❓\s+(.+)/)
    if (questionMatch) {
      if (currentQuestion && selected.length) results.push({ question: currentQuestion, selected })
      currentQuestion = questionMatch[1].trim()
      selected = []
      continue
    }
    if (currentQuestion) {
      const checkedMatch = line.match(/\s*-\s+\[x\]\s+[a-z]\)\s+(.+)/i)
      if (checkedMatch) {
        selected.push(checkedMatch[1].trim())
        continue
      }
      // Unchecked option — still part of this question
      const uncheckedMatch = line.match(/\s*-\s+\[\s+\]\s+[a-z]\)\s+(.+)/i)
      if (uncheckedMatch) continue
      // Line doesn't belong to this question anymore
      if (selected.length) results.push({ question: currentQuestion, selected })
      currentQuestion = null
      selected = []
    }
  }
  if (currentQuestion && selected.length) results.push({ question: currentQuestion, selected })
  return results
}

export function prdJsonToMarkdown(prdJson: string, taskType: string): string {
  try {
    const data = JSON.parse(prdJson)

    if (taskType.toLowerCase() !== 'technical') {
      // Functional PRD
      const p = data
      const stories = (p.user_stories ?? [])
        .map((s: any) => {
          const criteria = (s.acceptance_criteria ?? [])
            .map((c: any) => `  - **Given** ${c.given} **When** ${c.when} **Then** ${c.then}`)
            .join('\n')
          return `#### As a ${s.as_a}, I want ${s.i_want}, so that ${s.so_that}\n${criteria}`
        })
        .join('\n\n')

      const repos = (p.impacted_repos ?? [])
        .map((r: any) => `- **${r.repo}** (${r.estimated_effort}): ${r.rationale}`)
        .join('\n')

      const questions = (p.open_questions ?? []).map((q: any) => renderQuestion(q)).join('\n\n')
      const oos = (p.out_of_scope ?? []).map((s: string) => `- ${s}`).join('\n')
      const answered = (p.answered_questions ?? [])
        .map((a: any) => `- **${a.question}** → ${a.answer}`)
        .join('\n')

      return [
        '## 📋 Functional PRD',
        '',
        `### Problem Statement\n${p.problem_statement}`,
        '',
        '### User Stories',
        stories,
        '',
        '### Impacted Repos',
        repos,
        '',
        '### Out of Scope',
        oos,
        '',
        questions ? `### ❓ Open Questions\n${questions}` : '',
        answered ? `### 💬 Preguntas Respondidas\n${answered}` : '',
      ].filter(Boolean).join('\n')
    }

    // Technical PRD — one section per repo
    const sections: string[] = ['## 🔧 Technical PRD']
    for (const [repo, rd] of Object.entries(data) as [string, any][]) {
      const files = (rd.files_to_modify ?? [])
        .map((f: any) => `  - \`${f.path}\` (${f.change_type}): ${f.description}`)
        .join('\n')
      const scenarios = (rd.test_scenarios ?? [])
        .map((t: any) => `  - **${t.scenario}**: Given ${t.given} → When ${t.when} → Then ${t.then}`)
        .join('\n')
      const deps = (rd.dependencies ?? []).map((d: any) => `  - ${d.repo}: ${d.what}`).join('\n')
      const questions = (rd.open_questions ?? []).map((q: any) => renderQuestion(q, '  ')).join('\n\n')
      const api = rd.api_contract
        ? `\n**API Contract:** \`${rd.api_contract.method} ${rd.api_contract.endpoint}\``
        : ''

      sections.push(
        `\n### ${repo}${api}`,
        files ? `**Files to touch:**\n${files}` : '',
        rd.data_model_changes ? `**Data model changes:** ${rd.data_model_changes}` : '',
        scenarios ? `**Test scenarios:**\n${scenarios}` : '',
        deps ? `**Dependencies:**\n${deps}` : '',
        questions ? `**Open questions:**\n${questions}` : '',
      )
    }
    return sections.filter(Boolean).join('\n')
  } catch {
    return `## PRD\n\`\`\`json\n${prdJson}\n\`\`\``
  }
}
