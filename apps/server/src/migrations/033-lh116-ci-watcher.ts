import type { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Migration } from './runner.js'

const PROMPTS_DIR = join(import.meta.dir, '033-prompts')

function loadPrompt(name: string): string {
  return readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf8')
}

const CI_WATCHER_ID = 'lh116-ci-watcher'
const CI_WATCHER_PROMPT = loadPrompt('lh116-ci-watcher')
const CI_WATCHER_TOOLS = JSON.stringify(['set_task_field', 'add_task_comment'])

const REVIEWED_AGENTS = JSON.stringify([
  {
    agent: CI_WATCHER_ID,
    when: [{ field: 'labels', op: '!=', value: 'ci-checked' }],
    onError: '$set:Status=Build',
  },
])

// Idempotent snippet injected at the start of Paso 1 of the reviewer prompt so
// that every fresh review cycle clears the `ci-checked` label — otherwise a
// task returning from Build → Reviewed would inherit the label from the
// previous cycle and the CI watcher would never run again.
const LABEL_CLEAR_ANCHOR = 'El Implementer ya hizo `git push -u origin {{task.branch}}`.'
const LABEL_CLEAR_SNIPPET = [
  '### Limpia la label de CI del ciclo anterior',
  '',
  'Antes de tocar el remoto, remueve la label `ci-checked` del issue (idempotente — el `|| true` cubre el caso de que la label no exista todavía):',
  '',
  '```bash',
  'gh issue edit {{task.id}} --remove-label ci-checked 2>/dev/null || true',
  '```',
  '',
  'Esto permite que el `lh116-ci-watcher` se re-dispare cuando la card vuelva a `Reviewed`.',
  '',
  '',
].join('\n')

const migration: Migration = {
  id: '033-lh116-ci-watcher',
  description:
    'Agrega el agente `lh116-ci-watcher` wired al status Reviewed. Espera el CI del PR y devuelve a Build si falla; si pasa, marca el issue con la label `ci-checked` para que el gate `when` evite re-dispatch. Parchea el prompt del reviewer para limpiar la label al comienzo de cada ciclo.',
  up(db: Database): void {
    // 1. Upsert agent.
    const existing = db
      .query<{ id: string }, [string]>('SELECT id FROM agents WHERE id = ?')
      .get(CI_WATCHER_ID)

    if (existing) {
      db.run(
        'UPDATE agents SET prompt = ?, tools = ?, provider = ?, project_id = ?, position = ? WHERE id = ?',
        [CI_WATCHER_PROMPT, CI_WATCHER_TOOLS, 'iterm-claude', 'la-haus-116', 5, CI_WATCHER_ID],
      )
    } else {
      db.run(
        `INSERT INTO agents (
          id, position, provider, prompt, tools, project_id, requires_branch
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [CI_WATCHER_ID, 5, 'iterm-claude', CI_WATCHER_PROMPT, CI_WATCHER_TOOLS, 'la-haus-116', 0],
      )
    }

    // 2. Wire on Reviewed with when-gate.
    db.run(
      "UPDATE statuses SET agents = ? WHERE project_id = 'la-haus-116' AND name = 'Reviewed'",
      [REVIEWED_AGENTS],
    )

    // 3. Patch the lh116-reviewer prompt to remove the ci-checked label at the
    // start of each cycle. The REPLACE is idempotent because it only fires if
    // the snippet is not already present.
    const reviewer = db
      .query<{ prompt: string }, [string]>('SELECT prompt FROM agents WHERE id = ?')
      .get('lh116-reviewer')
    if (
      reviewer &&
      !reviewer.prompt.includes('gh issue edit {{task.id}} --remove-label ci-checked')
    ) {
      const patched = reviewer.prompt.replace(
        LABEL_CLEAR_ANCHOR,
        `${LABEL_CLEAR_SNIPPET}${LABEL_CLEAR_ANCHOR}`,
      )
      db.run('UPDATE agents SET prompt = ? WHERE id = ?', [patched, 'lh116-reviewer'])
    }
  },
}

export default migration
