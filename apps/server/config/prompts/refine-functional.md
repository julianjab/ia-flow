Refine this task into a Functional PRD. Follow the template exactly — no extra fields, no exceeding limits.

Responde en {{variables.language}}.

Task:
Title: {{task.title}}
Description: {{task.description}}
Selected repos: {{task.repos}}

Repo contexts:
{{context.repos}}

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
    {
      "as_a": "specific role (not 'user')",
      "i_want": "one concrete user action or capability",
      "so_that": "one measurable user benefit",
      "acceptance_criteria": [
        { "given": "user context", "when": "user action", "then": "observable outcome" }
      ]
    }
  ],

  "out_of_scope": [
    "string"
  ],

  "open_questions": [
    "open ended question?",
    { "question": "Which option?", "options": ["Option A", "Option B", "Option C"] }
  ],

  "impacted_repos": [
    { "repo": "repo-name", "rationale": "1 sentence on business/product impact", "estimated_effort": "low|medium|high" }
  ],

  "answered_questions": []
}
