Generate a Technical PRD for each listed repo. Follow the template exactly — no extra fields, no exceeding limits.

Responde en {{variables.language}}.

Task:
Title: {{task.title}}
Description: {{task.description}}
Repos: {{task.repos}}

Functional spec:
{{task.sections.functional_prd}}

Repo contexts:
{{context.repos}}

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
      { "repo": "repo-name", "what": "1 sentence" }
    ],

    "open_questions": [
      "open ended question?",
      { "question": "Which option?", "options": ["Option A", "Option B", "Option C"] }
    ],

    "answered_questions": []
  }
}
