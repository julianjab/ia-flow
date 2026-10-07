/**
 * `gh` de SÓLO LECTURA para el agente: lo justo para entender un CI en rojo (`gh run view
 * --log-failed`) sin darle el CLI entero. Con `gitCredential` configurado, `BashRunTool` le pasa
 * el token a estos comandos por el env del hijo (`GH_TOKEN`); cualquier otro `gh` se rechaza
 * antes de spawnear. La allowlist es cerrada a propósito: `gh auth token` imprimiría la
 * credencial, `gh api` escribe, y un host o un `--repo HOST/o/r` ajeno recibiría el token.
 */

/** Subcomandos permitidos y los flags que cada uno admite (todos de lectura). */
const ALLOWED: Record<string, Record<string, { flags: Set<string>; valued: Set<string> }>> = {
  run: {
    view: {
      flags: new Set(['--log', '--log-failed', '--verbose', '-v', '--exit-status']),
      valued: new Set(['--job', '-j', '--attempt', '--json', '--jq', '--repo', '-R']),
    },
    list: {
      flags: new Set([]),
      valued: new Set([
        '--limit',
        '-L',
        '--branch',
        '-b',
        '--commit',
        '-c',
        '--status',
        '-s',
        '--workflow',
        '-w',
        '--event',
        '-e',
        '--json',
        '--jq',
        '--repo',
        '-R',
      ]),
    },
  },
  pr: {
    checks: {
      flags: new Set(['--required', '--fail-fast']),
      valued: new Set(['--json', '--jq', '--repo', '-R']),
    },
    view: {
      flags: new Set(['--comments']),
      valued: new Set(['--json', '--jq', '--repo', '-R']),
    },
  },
}

/** `owner/repo` y nada más: `HOST/owner/repo` mandaría el token a otro host. */
const REPO = /^[\w.-]+\/[\w.-]+$/
/** Un id, un número o una branch — sin `:` ni `//`, así una URL de otro host no entra. */
const POSITIONAL = /^[\w.-]+(\/[\w.-]+)*$/

/** Por qué un `gh` NO puede recibir el token, o `undefined` si es una forma de lectura permitida. */
export function ghReadOnlyRisk(argv: string[]): string | undefined {
  const [, group, action, ...rest] = argv
  const spec = group && action ? ALLOWED[group]?.[action] : undefined
  if (!spec) {
    return `gh ${argv.slice(1, 3).join(' ')} no está permitido (sólo: ${Object.entries(ALLOWED)
      .flatMap(([g, actions]) => Object.keys(actions).map((a) => `${g} ${a}`))
      .join(', ')})`
  }
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string
    if (!token.startsWith('-')) {
      if (!POSITIONAL.test(token)) return `argumento "${token}" no es un id, número o branch`
      continue
    }
    if (token.includes('=')) return `${token}: pasá el valor como argumento aparte`
    if (spec.flags.has(token)) continue
    if (!spec.valued.has(token)) return `${token} no está permitido en gh ${group} ${action}`
    const value = rest[++i]
    if (value === undefined) return `${token} necesita un valor`
    if ((token === '--repo' || token === '-R') && !REPO.test(value)) {
      return `${token} ${value}: sólo owner/repo (un host ajeno recibiría el token)`
    }
  }
  return undefined
}

/** El env mínimo que `gh` necesita para hablar con github.com con el token, sin prompts. */
export function ghEnv(base: Record<string, string>, token: string): Record<string, string> {
  return {
    ...base,
    GH_TOKEN: token,
    GH_HOST: 'github.com',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
  }
}
