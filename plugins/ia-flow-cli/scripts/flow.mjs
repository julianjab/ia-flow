#!/usr/bin/env node
// El borde: `gh`, el spawn del CLI, y el orden en que pasan las cosas.
//
// Todo lo que decide algo vive en `core.mjs` y no tiene I/O. Acá está lo que
// no se puede testear sin red — y por eso, cuanto menos criterio tenga este
// archivo, mejor: cada `if` que se escriba acá es un `if` que no se puede
// testear.
//
//   flow.mjs run <n> [--exec claude|print] [--dry-run] [--agent id] [--force]
//   flow.mjs apply <n> --exit <nombre> [--summary "..."]
//
// `run` es el ciclo completo del engine para un issue. `apply` es su última
// mitad, expuesta aparte para que la sesión interactiva de Claude pueda ser el
// ejecutor sin reimplementar la transición.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CONFIG_CANDIDATES,
  ConfigError,
  HOME_CONFIG,
  StatusLabels,
  applyPatch,
  buildComment,
  buildContext,
  explainNoMatch,
  isTracked,
  normalizeConfig,
  parseExitMarker,
  parseSet,
  parseYaml,
  renderTemplate,
  resolveCommentTarget,
  resolveExit,
  selectAgent,
} from './core.mjs'

// ─── Salida a consola ────────────────────────────────────────────────────

const log = (msg) => process.stderr.write(`${msg}\n`)
const out = (msg) => process.stdout.write(`${msg}\n`)

class FlowError extends Error {}

// ─── Config ──────────────────────────────────────────────────────────────

/** El primer candidato que exista. `$IA_FLOW_CLI_CONFIG` gana sobre todos —
 *  es la forma de apuntar a un roster que no vive en este repo. */
export function findConfigPath(cwd, env = process.env) {
  if (env.IA_FLOW_CLI_CONFIG) return env.IA_FLOW_CLI_CONFIG
  const candidates = [...CONFIG_CANDIDATES.map((p) => join(cwd, p)), join(homedir(), HOME_CONFIG)]
  return candidates.find((p) => existsSync(p)) ?? null
}

function loadConfig(cwd) {
  const path = findConfigPath(cwd)
  if (!path) {
    throw new FlowError(
      `No encontré un runner.yaml. Buscá en:\n  - ${CONFIG_CANDIDATES.join('\n  - ')}\n` +
        `  - ~/${HOME_CONFIG}\no apuntá a uno con IA_FLOW_CLI_CONFIG.`,
    )
  }
  const config = normalizeConfig(parseYaml(readFileSync(path, 'utf-8')))
  return { ...config, path }
}

// ─── gh ──────────────────────────────────────────────────────────────────

function gh(args, { input } = {}) {
  const res = spawnSync('gh', args, { input, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 })
  if (res.error?.code === 'ENOENT') {
    throw new FlowError("No encontré el comando 'gh'. Instalá GitHub CLI y corré 'gh auth login'.")
  }
  if (res.status !== 0) {
    throw new FlowError(
      `gh ${args.slice(0, 3).join(' ')} falló:\n${res.stderr?.trim() || res.stdout?.trim()}`,
    )
  }
  return res.stdout
}

function currentRepo() {
  return JSON.parse(gh(['repo', 'view', '--json', 'name,owner,nameWithOwner']))
}

const ISSUE_FIELDS = 'number,title,body,labels,author,comments,url,state,assignees'

/** El issue en la forma que espera `core.mjs`: labels y assignees como arrays
 *  de strings, y el status ya derivado de la label. */
function fetchIssue(number, statusLabels, repo) {
  const raw = JSON.parse(gh(['issue', 'view', String(number), '--json', ISSUE_FIELDS]))
  const labels = (raw.labels ?? []).map((l) => l.name)
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    url: raw.url,
    state: (raw.state ?? 'OPEN').toLowerCase(),
    author: raw.author?.login ?? '',
    assignees: (raw.assignees ?? []).map((a) => a.login),
    labels,
    status: statusLabels.statusFrom(labels),
    repo: repo.name,
    comments: (raw.comments ?? []).map((c) => ({
      author: c.author?.login ?? '',
      body: c.body ?? '',
      createdAt: c.createdAt,
    })),
  }
}

/** Las labels frescas, para resolver el delta contra ellas y no contra las que
 *  vimos al arrancar el run. */
function freshLabels(number) {
  const raw = JSON.parse(gh(['issue', 'view', String(number), '--json', 'labels']))
  return (raw.labels ?? []).map((l) => l.name)
}

/**
 * Escribe la lista final de labels como un delta.
 *
 * `gh issue edit` toma `--add-label`/`--remove-label`, no un set completo, así
 * que el delta se calcula acá contra lo que el issue tiene AHORA. Es lo que
 * evita pisar una label que un humano agregó mientras el agente trabajaba.
 */
function writeLabels(number, current, next) {
  const lower = (xs) => xs.map((x) => x.toLowerCase())
  const add = next.filter((l) => !lower(current).includes(l.toLowerCase()))
  const remove = current.filter((l) => !lower(next).includes(l.toLowerCase()))
  if (add.length === 0 && remove.length === 0) return { add, remove }
  gh([
    'issue',
    'edit',
    String(number),
    ...add.flatMap((l) => ['--add-label', l]),
    ...remove.flatMap((l) => ['--remove-label', l]),
  ])
  return { add, remove }
}

const postComment = (number, body) =>
  gh(['issue', 'comment', String(number), '--body-file', '-'], { input: body })

// ─── Ejecutores ──────────────────────────────────────────────────────────

/**
 * Lanza `claude -p` y devuelve cómo terminó más su último mensaje.
 *
 * `--output-format json` es lo que hace fiable leer la salida: el texto final
 * viene en un campo (`result`) en vez de mezclado con lo que el CLI imprima
 * alrededor. Si no parsea, se cae al stdout crudo — el bloque `<ia-flow:exit>`
 * se encuentra igual, y perder el formato es mejor que perder el run.
 */
function runClaude(prompt, agent, settings) {
  const args = ['-p', prompt, '--output-format', 'json']
  if (agent.tools?.length) args.push('--allowedTools', agent.tools.join(','))
  args.push(...settings.claudeArgs)

  const res = spawnSync('claude', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
  if (res.error?.code === 'ENOENT') {
    throw new FlowError("No encontré el comando 'claude'. Instalá Claude Code.")
  }
  let text = res.stdout ?? ''
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.result === 'string') text = parsed.result
  } catch {
    // stdout crudo: sirve igual para buscar el marker.
  }
  return { ok: res.status === 0, text, stderr: res.stderr }
}

/** El "ejecutor" de la sesión interactiva: imprime el trabajo y se va. Quien
 *  cierra el run es `apply`, con el mismo código de transición que usa el
 *  camino headless. */
function printWork({ issue, agent, prompt }) {
  out(`## Agente seleccionado: ${agent.id}`)
  out(`## Issue #${issue.number} — ${issue.title}`)
  out(`## Estado actual: ${issue.status || '(sin status)'}`)
  out('')
  out('--- PROMPT ---')
  out(prompt)
  out('--- FIN DEL PROMPT ---')
  out('')
  out('Hacé este trabajo ahora. Cuando termines, cerrá el run con:')
  out(`  node ${process.argv[1]} apply ${issue.number} --exit <salida> --summary "<una línea>"`)
  out('')
  out("Las salidas disponibles están en el prompt; 'success' es la normal.")
}

// ─── La transición ───────────────────────────────────────────────────────

/**
 * Cierra un run: comenta y mueve el issue. Es la segunda mitad de `run` y todo
 * lo que hace `apply`, para que los dos caminos no puedan divergir.
 */
function closeRun({ issue, agent, statusLabels, exitName, summary, dryRun }) {
  const exit = agent.exits?.[exitName]
  const target = resolveCommentTarget(exit, agent.comment)
  const set = typeof exit === 'string' ? exit : exit?.set
  const patch = set ? parseSet(set) : null

  const plan = { exit: exitName, comment: target, set: set ?? '(ninguna)' }
  if (dryRun) return plan

  if (target !== 'none' && summary) {
    // `pr` y `pr-else-issue` caen al issue en esta versión: el merge con los
    // comentarios de PRs abiertos es fase 2. Cae, no falla — perder el reporte
    // de un run es peor que dejarlo en el lugar menos específico, que es la
    // misma regla que aplica el engine cuando un `comment: pr` no tiene PR.
    postComment(issue.number, buildComment(agent.id, summary))
    plan.commented = true
  }

  const current = freshLabels(issue.number)
  let next = patch ? applyPatch(current, patch, statusLabels) : [...current]
  next = statusLabels.withWorking(next, false)
  plan.labels = writeLabels(issue.number, current, next)

  if (patch?.state === 'closed') gh(['issue', 'close', String(issue.number)])
  else if (patch?.state === 'open') gh(['issue', 'reopen', String(issue.number)])
  if (patch?.assignees) {
    gh([
      'issue',
      'edit',
      String(issue.number),
      ...patch.assignees.flatMap((a) => ['--add-assignee', a]),
    ])
  }
  return plan
}

// ─── Los comandos ────────────────────────────────────────────────────────

function resolveTarget(number, { agentId } = {}) {
  const cwd = process.cwd()
  const { settings, agents, path } = loadConfig(cwd)
  const statusLabels = new StatusLabels({
    prefix: settings.statusPrefix,
    working: settings.workingLabel,
  })
  const repo = currentRepo()
  const issue = fetchIssue(number, statusLabels, repo)

  let agent
  if (agentId) {
    agent = agents.find((a) => a.id === agentId)
    if (!agent) throw new FlowError(`El runner.yaml no declara un agente '${agentId}' (${path})`)
  } else {
    agent = selectAgent(agents, issue)
  }
  return { settings, agents, statusLabels, repo, issue, agent, configPath: path }
}

function cmdRun(number, flags) {
  const ctx = resolveTarget(number, { agentId: flags.agent })
  const { settings, agents, statusLabels, repo, issue, agent } = ctx

  if (!isTracked(issue.labels, settings.anchorLabel)) {
    log(
      `Issue #${number}: no tiene la label ancla '${settings.anchorLabel}' — el pipeline no lo toca.`,
    )
    return 0
  }
  if (statusLabels.isWorking(issue.labels) && !flags.force) {
    log(
      `Issue #${number}: ya tiene '${settings.workingLabel}' — hay un run en vuelo, o quedó colgado.\n` +
        'Si quedó colgado, volvé a correr con --force.',
    )
    return 0
  }
  if (!agent) {
    log(`Issue #${number} (status '${issue.status || 'sin status'}'): ningún agente matchea.`)
    for (const reason of explainNoMatch(agents, issue)) log(`  - ${reason}`)
    return 0
  }

  const prompt = renderTemplate(agent.prompt, buildContext({ issue, agent, repo }))
  const exec = flags.exec ?? settings.exec

  if (flags.dryRun) {
    out(`Agente:  ${agent.id}`)
    out(`Issue:   #${issue.number} — ${issue.title}`)
    out(`Estado:  ${issue.status || '(sin status)'}`)
    out(`Ejecutor: ${exec}`)
    out('')
    out('--- PROMPT ---')
    out(prompt)
    out('--- FIN ---')
    out('')
    const plan = closeRun({ issue, agent, statusLabels, exitName: 'success', dryRun: true })
    out(`Si saliera por 'success': ${plan.set}  (comentario → ${plan.comment})`)
    return 0
  }

  // A partir de acá el issue queda marcado. El `finally` es lo único que
  // garantiza que no se quede así si el ejecutor explota.
  const before = freshLabels(issue.number)
  writeLabels(issue.number, before, statusLabels.withWorking(before, true))

  if (exec === 'print') {
    // No hay `finally` que valga: el trabajo lo hace otro proceso y el marker
    // lo levanta `apply`. Si la sesión abandona, `--force` es la salida.
    printWork({ issue, agent, prompt })
    return 0
  }

  try {
    const result = runClaude(prompt, agent, settings)
    const marker = parseExitMarker(result.text)
    const { name, reason } = resolveExit(agent, marker?.exit, result.ok)
    if (reason) log(`Aviso: ${reason} — se aplica '${name}'.`)
    if (!result.ok) log(`El run terminó con error. stderr:\n${result.stderr?.trim() ?? '(vacío)'}`)

    const summary = marker?.summary ?? result.text
    const plan = closeRun({ issue, agent, statusLabels, exitName: name, summary })
    log(`Issue #${issue.number}: ${agent.id} salió por '${name}' → ${plan.set}`)
    return result.ok ? 0 : 1
  } finally {
    // `closeRun` ya lo saca en el camino feliz; esto cubre el que tira.
    const now = freshLabels(issue.number)
    if (statusLabels.isWorking(now))
      writeLabels(issue.number, now, statusLabels.withWorking(now, false))
  }
}

function cmdApply(number, flags) {
  if (!flags.exit) throw new FlowError('Falta --exit <nombre> (por ejemplo: --exit success)')
  const { statusLabels, issue, agent } = resolveTarget(number, { agentId: flags.agent })
  if (!agent) {
    throw new FlowError(
      `Issue #${number}: ningún agente matchea, así que no sé de quién es esta salida. ` +
        'Pasá --agent <id>.',
    )
  }
  const { name, reason } = resolveExit(agent, flags.exit, true)
  if (reason) log(`Aviso: ${reason} — se aplica '${name}'.`)
  const plan = closeRun({ issue, agent, statusLabels, exitName: name, summary: flags.summary })
  log(`Issue #${issue.number}: ${agent.id} salió por '${name}' → ${plan.set}`)
  return 0
}

// ─── Entrada ─────────────────────────────────────────────────────────────

const USAGE = `ia-flow-cli — el pipeline de issues del engine, para un issue

  flow.mjs run <issue> [--exec claude|print] [--dry-run] [--agent <id>] [--force]
  flow.mjs apply <issue> --exit <nombre> [--summary "..."] [--agent <id>]

Config: $IA_FLOW_CLI_CONFIG, .claude/ia-flow/runner.yaml, .flow/runner.yaml,
        o ~/.claude/ia-flow/runner.yaml (el primero que exista).`

export function parseArgs(argv) {
  const [command, target, ...rest] = argv
  const flags = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--dry-run') flags.dryRun = true
    else if (arg === '--force') flags.force = true
    else if (arg === '--exec') flags.exec = rest[++i]
    else if (arg === '--agent') flags.agent = rest[++i]
    else if (arg === '--exit') flags.exit = rest[++i]
    else if (arg === '--summary') flags.summary = rest[++i]
    else throw new FlowError(`Flag desconocida: '${arg}'`)
  }
  return { command, target, flags }
}

function main(argv) {
  const { command, target, flags } = parseArgs(argv)
  if (!command || command === '--help' || command === '-h') {
    out(USAGE)
    return 0
  }
  const number = Number.parseInt(target ?? '', 10)
  if (!Number.isInteger(number) || number <= 0) {
    throw new FlowError(`'${target ?? ''}' no es un número de issue.\n\n${USAGE}`)
  }
  if (command === 'run') return cmdRun(number, flags)
  if (command === 'apply') return cmdApply(number, flags)
  throw new FlowError(`Comando desconocido: '${command}'.\n\n${USAGE}`)
}

// El guard hace que importar este archivo desde un test no corra el CLI.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (err) {
    if (err instanceof FlowError || err instanceof ConfigError) {
      log(err.message)
      process.exit(2)
    }
    throw err
  }
}
