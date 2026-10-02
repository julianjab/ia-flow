/**
 * Las actions que trae el runner: las ve toda fuente, sin declararlas en `runner.yaml`. Una config
 * sólo declara las suyas (`sources.actions` o las de un proyecto); un id repetido rompe el arranque.
 *
 *   github.ts        transiciones del board y tools de GitHub (`@ia-flow/github-tools`)
 *   slack.ts         leer y publicar en Slack, y pedir review (`request_slack_review`)
 *   workspace.ts     fs_*, bash_run, run_agent y el worktree de la task (`@ia-flow/workspace`)
 *   resolve_task.ts  el intake: de un webhook al evento de su task (`src/intake/`)
 *   assistant.ts     las tools del asistente de la web
 *   tasks.ts         relanzar una task o volver a correr su review (las pide la bandeja)
 */
import type { Definition } from '../defineAction.js'
import assistant from './assistant.js'
import github from './github.js'
import resolveTask from './resolve_task.js'
import slack from './slack.js'
import tasks from './tasks.js'
import workspace from './workspace.js'

export const BUILTIN_ACTIONS: Definition[] = [
  ...github,
  ...slack,
  ...workspace,
  resolveTask,
  assistant,
  tasks,
].flat()
