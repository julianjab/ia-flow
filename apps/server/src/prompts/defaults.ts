// Default per-phase prompt templates. Kept out of orchestrator.ts so that they
// can be overridden via ProviderConfig.phasePrompts and rendered with
// placeholder substitution. Each template contains `Responde en {response_language}.`
// and uses the placeholders documented in ./variables.ts.
import type { StepType } from '@ia-flow/shared'

const FUNCTIONAL = `Refine this task into a Functional PRD. Follow the template exactly — no extra fields, no exceeding limits.

Responde en {response_language}.

Task:
Title: {task_title}
Description: {task_description}
Selected repos: {repos}
{checkbox_answers}{comments}
Repo contexts:
{contexts}

Rules:
- This is a FUNCTIONAL PRD — describe WHAT and WHY, never HOW. No file paths, no endpoints, no DB schemas, no implementation details.
- user_stories must describe user-visible behavior only. No technical steps, no API calls, no code references.
- acceptance_criteria must be testable from a user's perspective — observable outcomes, not implementation checks.
- impacted_repos: only name the repo and one sentence on business rationale. No file names, no technical specifics.
- Identify ALL blocking open_questions upfront — do not defer any to future refinements.
- Only add to open_questions what is strictly blocking — do not guess, do not assume.
- Respect ALL limits in the template. Do not exceed them.

Template (return ONLY this JSON, no markdown, no extra text):
{
  "problem_statement": "1-2 sentences max. What problem does this solve and for whom.",

  "user_stories": [
    // MAX 5 stories. Describe user-visible behavior only — no file paths, no API calls, no code.
    {
      "as_a": "specific role (not 'user')",
      "i_want": "one concrete user action or capability",
      "so_that": "one measurable user benefit",
      "acceptance_criteria": [
        // MAX 3 criteria. Observable from the user's perspective — not implementation checks.
        { "given": "user context", "when": "user action", "then": "observable outcome" }
      ]
    }
  ],

  "out_of_scope": [
    // MAX 5 items. Only what might be confused as in-scope.
    "string"
  ],

  "open_questions": [
    // Only strictly blocking business/product questions — omit technical decisions.
    // List ALL blocking questions here — do not defer any to future refinements.
    "open ended question?",
    { "question": "Which option?", "options": ["Option A", "Option B", "Option C"] }
  ],

  "impacted_repos": [
    // One entry per repo. MAX 5. Rationale = business reason only, no technical details.
    { "repo": "repo-name", "rationale": "1 sentence on business/product impact", "estimated_effort": "low|medium|high" }
  ],

  "answered_questions": [
    // Include ONLY if there were checkbox answers or team comments above.
    // One entry per question that was answered — map it to the answer used.
    { "question": "the original question text", "answer": "the answer that was used in this PRD" }
  ]
}`

const TECHNICAL = `Generate a Technical PRD for each listed repo. Follow the template exactly — no extra fields, no exceeding limits.

Responde en {response_language}.

Task:
Title: {task_title}
Description: {task_description}
Repos: {repos}
{checkbox_answers}{comments}
Repo contexts:
{contexts}

Rules:
- All file paths must exist in the directory structure shown. Do not invent paths.
- If a path is uncertain, add it to open_questions — do not guess.
- Identify ALL blocking open_questions upfront in this pass — do not defer questions to future refinements.
- Test scenarios must be concrete BDD, not vague.
- api_contract: omit entirely if no HTTP endpoint is added or changed.
- data_model_changes: null if none.
- Respect ALL limits in the template. Do not exceed them.

Template (return ONLY this JSON, no markdown, no extra text):
{
  "<repo_name>": {
    "repo": "repo-name",

    "files_to_modify": [
      // MAX 8 files. Only files that need to change.
      { "path": "exact/relative/path", "change_type": "create|modify|delete", "description": "1 sentence" }
    ],

    "api_contract": {
      // Omit this field entirely if no endpoint changes.
      "endpoint": "/path", "method": "GET|POST|PUT|DELETE|PATCH",
      "request_schema": {}, "response_schema": {}
    },

    "data_model_changes": "1-2 sentences or null",

    "test_scenarios": [
      // MAX 5 scenarios. BDD only — Given/When/Then must be concrete and verifiable.
      { "scenario": "name", "given": "context", "when": "action", "then": "result" }
    ],

    "dependencies": [
      // MAX 3. Only hard dependencies on other repos.
      { "repo": "repo-name", "what": "1 sentence" }
    ],

    "open_questions": [
      // Only strictly blocking — omit if answerable from context.
      // List ALL blocking questions here — do not defer any to future refinements.
      "open ended question?",
      { "question": "Which option?", "options": ["Option A", "Option B", "Option C"] }
    ],

    "answered_questions": [
      // Include ONLY if there were checkbox answers or team comments above.
      { "question": "the original question text", "answer": "the answer that was used in this PRD" }
    ]
  }
}`

const IMPLEMENT = `Implement this GitHub issue: https://github.com/{github_remote}/issues/{issue_number}

Responde en {response_language}.

Task:
Title: {task_title}
Description: {task_description}
Type: {task_type}
Repos: {repos}
{checkbox_answers}{comments}
Git setup (already applied before this prompt was sent — do NOT redo this):
{git_context}

Repo context:
{contexts}

Rules:
1. Read CLAUDE.md before anything else — follow its conventions strictly.
2. Use sub-agents and skills in .claude/ where appropriate (/qa for tests, /backend or /frontend for implementation).
3. Read every file listed in "Files to Modify" before touching it.
4. {checkbox_snippet}
5. Write and pass all tests in "Test Scenarios" — check their checkboxes when done.
6. Run lint and tests before committing.
7. Commit with a conventional commit message referencing #{issue_number}.
8. {pr_instruction}
{in_review_snippet}

Repo PRD:
{repo_prd}

Do not implement open_questions — add TODO comments instead.`

// Template used by orchestrateTechnicalDecompose. Not user-overridable via
// ProviderConfig.phasePrompts (only 3 canonical StepType keys), but extracted
// here so all phase templates live in one place.
export const DEFAULT_TECHNICAL_DECOMPOSE_PROMPT = `Decompose this approved Functional PRD into technical sub-tasks, one per PR.

Responde en {response_language}.

Functional task: {task_title}
Repos: {repos}

Functional PRD:
{functional_prd_markdown}

Repo contexts:
{contexts}

Rules:
- Each sub-task must fit in a single PR: focused, independently mergeable, single responsibility.
- One sub-task per logical unit of work. Split by repo if changes are independent; keep together if they must ship atomically.
- Title must follow conventional commits: feat(scope): description
- All file paths must exist in the directory structure shown. Do not invent paths.
- CRITICAL: Sub-tasks will be implemented independently by separate agents with no shared context. You MUST pre-decide all cross-cutting concerns NOW: API contracts, shared types, field names, endpoint paths, DB schema. Do NOT leave inter-task decisions as open_questions — decide them here and document them in each relevant sub-task.
- open_questions are ONLY for things unknown to you right now (business rules, external constraints). Never ask something that another sub-task in this list will decide.
- Use the dependencies field to declare what one sub-task needs from another and what the agreed contract is.
- api_contract: omit entirely if no HTTP endpoint is added or changed.
- data_model_changes: null if none.
- Test scenarios must be concrete BDD — Given/When/Then must be specific and verifiable.

Return ONLY a JSON array, no markdown, no extra text:
[
  {
    "title": "feat(scope): description",
    "repo": "exact-repo-name",
    "description": "1-2 sentences: what this PR does and why",
    "files_to_modify": [
      { "path": "exact/relative/path", "change_type": "create|modify|delete", "description": "1 sentence" }
    ],
    "api_contract": {
      "endpoint": "/path", "method": "GET|POST|PUT|DELETE|PATCH",
      "request_schema": {}, "response_schema": {}
    },
    "data_model_changes": "1-2 sentences or null",
    "test_scenarios": [
      { "scenario": "name", "given": "context", "when": "action", "then": "result" }
    ],
    "dependencies": [
      { "repo": "repo-name", "what": "1 sentence — what this sub-task needs from that repo" }
    ],
    "open_questions": [
      "open ended question?",
      { "question": "Which option?", "options": ["Option A", "Option B"] }
    ]
  }
]`

export const DEFAULT_PHASE_PROMPTS: Record<StepType, string> = {
  'refine-functional': FUNCTIONAL,
  'refine-technical': TECHNICAL,
  'implement': IMPLEMENT,
}
