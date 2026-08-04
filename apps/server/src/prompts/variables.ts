// Source of truth for placeholders supported by each phase's prompt template.
// Used by the server's rendering path (docs / validation) and by the UI so the
// prompt editor can offer variable chips per phase.
import type { StepType } from '@ia-flow/shared'

export interface PhaseVariable {
  name: string
  description: string
}

const COMMON: PhaseVariable[] = [
  { name: 'task_title', description: 'Task title (issue title).' },
  { name: 'task_description', description: 'Task description / issue body.' },
  { name: 'task_type', description: 'Task type — "functional" or "technical".' },
  { name: 'repos', description: 'Comma-separated list of selected repo names.' },
  { name: 'checkbox_answers', description: 'Pre-formatted block of answers collected from issue checkboxes (empty when none).' },
  { name: 'comments', description: 'Pre-formatted block of team comments on the issue (empty when none).' },
  { name: 'contexts', description: 'Pre-rendered repo context sections (CLAUDE.md snippets, manifests, directory trees).' },
  { name: 'response_language', description: 'Language the model should respond in (e.g. "español", "english").' },
]

export const PHASE_VARIABLES: Record<StepType, PhaseVariable[]> = {
  'refine-functional': COMMON,
  'refine-technical': COMMON,
  'implement': [
    ...COMMON,
    { name: 'issue_number', description: 'GitHub issue number (integer, empty when not linked to an issue).' },
    { name: 'repo_name', description: 'Target repo name (without owner).' },
    { name: 'github_remote', description: 'GitHub remote "owner/repo" — empty when no GitHub remote is configured.' },
    { name: 'repo_prd', description: 'Repo-scoped section of the technical PRD, JSON-formatted.' },
    { name: 'checkbox_snippet', description: 'Pre-rendered gh CLI snippet for checking issue checkboxes (empty when no issue number).' },
    { name: 'in_review_snippet', description: 'Pre-rendered gh graphql snippet to move the issue to "In Review" (empty when project metadata is missing).' },
    { name: 'pr_instruction', description: 'Rendered instruction line about opening a PR or skipping when no GitHub remote is detected.' },
  ],
}
