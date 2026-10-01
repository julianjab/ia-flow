/**
 * Matcher POSICIONAL de patrones tipo `git push * main` contra un argv ya tokenizado — mismo
 * modelo que la policy real de `20-implementer.yaml` en ai-development-flow. Documentado ahí
 * mismo como fricción, no como sandbox: un patrón cubre las formas más obvias en las
 * posiciones que mira, no es un parser de flags. Ver `README.md` → "Límites honestos".
 */

export interface BashPolicy {
  /** Default `['*']` — todo permitido salvo lo que matchee `deny`. */
  allow?: string[]
  /** `deny` siempre gana sobre `allow`, incluso si un patrón matchea ambos. */
  deny: string[]
}

/** Split en tokens por whitespace, sin soportar comillas ni escapes — a propósito: `bash_run`
 *  no corre shell, así que no hay quoting real que interpretar; un patrón de policy es texto
 *  literal token a token, nunca una expresión. */
function tokenize(pattern: string): string[] {
  return pattern.split(/\s+/).filter((token) => token.length > 0)
}

/** `*` como último token del patrón = "cualquier cantidad de tokens desde acá, incluso cero".
 *  Un `*` en medio del patrón matchea exactamente UN token cualquiera. Un token que termina en
 *  `*` (ej. `--force*`) es un prefix match sobre ESE token puntual. */
export function matchesPattern(argv: string[], pattern: string): boolean {
  const patternTokens = tokenize(pattern)
  if (patternTokens.length === 0) return false

  const trailingWildcard = patternTokens[patternTokens.length - 1] === '*'
  const fixedTokens = trailingWildcard ? patternTokens.slice(0, -1) : patternTokens

  if (trailingWildcard) {
    if (argv.length < fixedTokens.length) return false
  } else if (argv.length !== patternTokens.length) {
    return false
  }

  for (let i = 0; i < fixedTokens.length; i++) {
    const patternToken = fixedTokens[i]
    const argToken = argv[i]
    if (patternToken === '*') continue
    if (patternToken.endsWith('*')) {
      if (!argToken.startsWith(patternToken.slice(0, -1))) return false
    } else if (argToken !== patternToken) {
      return false
    }
  }
  return true
}

/**
 * Chequeo DEDICADO, no posicional, para `git push` contra `main`/`master` — el matcher de
 * patrones por posición fija se probó insuficiente acá: `git push -u origin main` (origin en
 * la posición 3, no la 2), `git push origin +main` (force vía refspec, sin `--force`), `git
 * push origin :main`/`--delete origin main` (borra la branch), y `git push origin
 * HEAD:refs/heads/main` quedaban todos afuera de cualquier patrón de posición fija razonable.
 * En vez de perseguir cada variante con más patrones, busca `main`/`master` (o sus formas de
 * refspec) en CUALQUIER posición después de `push` — siempre activo, no depende de lo que el
 * caller ponga en `deny`, mismo criterio que el chequeo de `argv[0]` calificado por path en
 * `BashRunTool`.
 */
function isDangerousGitPush(argv: string[]): boolean {
  if (argv[0] !== 'git') return false
  const pushIndex = argv.indexOf('push')
  if (pushIndex === -1) return false
  return argv.slice(pushIndex + 1).some((token) => {
    if (token === 'main' || token === 'master') return true
    if (token === '--delete' || token === '-d' || token === '--all' || token === '--mirror') {
      return true
    }
    if (token.startsWith('+')) return true // refspec force: +<src>:<dst>
    if (token.endsWith(':main') || token.endsWith(':master')) return true
    if (token.endsWith(':refs/heads/main') || token.endsWith(':refs/heads/master')) return true
    if (token === 'refs/heads/main' || token === 'refs/heads/master') return true
    return false
  })
}

/**
 * `-c <key>=<value>`, `--config-env`, y el subcomando `config` reconfiguran git — por invocación
 * o de forma persistente — con las mismas keys peligrosas (`alias.*`, `core.sshCommand`,
 * `core.pager`, `core.hooksPath`, `credential.helper`). Un patrón posicional (`'git -c *'`,
 * `'git config *'`) sólo mira `argv[1]`, así que CUALQUIER opción global antes (`git -C . -c
 * ...`, `git --git-dir=x config ...`) lo esquiva. Recorre TODO argv en vez de una posición fija
 * — mismo criterio que `isDangerousGitTransport`.
 */
function isDangerousGitConfig(argv: string[]): boolean {
  if (argv[0] !== 'git') return false
  return argv.some(
    (token, i) =>
      i > 0 && (token === '-c' || token === 'config' || token.startsWith('--config-env')),
  )
}

/**
 * `git fetch`/`clone`/`ls-remote --upload-pack=<cmd>`, `git push --receive-pack=<cmd>` y
 * `--exec=<cmd>` (alias de ambos) hacen que git invoque `<cmd>` como su propio helper de
 * transporte — ejecución arbitraria, mismo nivel que `-c`. `clone`/`ls-remote` aceptan además la
 * forma corta `-u <cmd>` o pegada `-u<cmd>` (en `fetch`, `-u` es otra cosa: `--update-head-ok`).
 * Esa forma corta se rechaza si `clone`/`ls-remote` aparece en CUALQUIER posición — no sólo en
 * `argv[1]`: una opción global (`git -C . clone -u…`) corre el subcomando de lugar. Conservador a
 * propósito: un `fetch -u` con un argumento que se llame `clone` también cae. El flag puede ir
 * en cualquier posición, igual que `-c`, así que es otro chequeo dedicado en vez de un patrón
 * posicional. Nota de alcance: GNU permite ABREVIAR long options (`--upload-p=...`) —
 * `startsWith` no cubre toda abreviación posible; ver README → "Límites honestos".
 */
function isDangerousGitTransport(argv: string[]): boolean {
  if (argv[0] !== 'git') return false
  const takesShortUploadPack = argv.includes('clone') || argv.includes('ls-remote')
  const shortUploadPack = takesShortUploadPack && argv.some((token) => token.startsWith('-u'))
  return (
    shortUploadPack ||
    argv.some(
      (token) =>
        token.startsWith('--upload-pack') ||
        token.startsWith('--receive-pack') ||
        token.startsWith('--exec'),
    )
  )
}

/**
 * Subcomandos de git que corren un comando arbitrario que LES PASÁS COMO ARGUMENTO — categoría
 * aparte de `--upload-pack`/`--exec` (que son flags de transporte): `rebase -x`/`--exec`,
 * `bisect run`, `submodule foreach`, y `filter-branch --tree-filter`/`--index-filter` ejecutan
 * ese comando directo, sin intermediar ningún transporte. `isDangerousGitTransport` ya cubre la
 * forma larga `--exec`, pero no la corta `-x` (alias de `rebase --exec`) ni los otros tres.
 */
function isDangerousGitExecSubcommand(argv: string[]): boolean {
  if (argv[0] !== 'git') return false
  if (argv.includes('-x')) return true // git rebase -x <cmd>
  if (argv.includes('foreach')) return true // git submodule foreach <cmd>
  const bisectIndex = argv.indexOf('bisect')
  if (bisectIndex !== -1 && argv[bisectIndex + 1] === 'run') return true
  if (argv.some((t) => t.startsWith('--tree-filter') || t.startsWith('--index-filter'))) {
    return true
  }
  return false
}

/**
 * `git push` (o `git push origin`, o `git push origin HEAD`) sin nombrar una branch destino
 * explícita empuja la que esté CHECKOUTEADA en ese momento — algo que `isDangerousGitPush` no
 * puede ver desde un único `argv` aislado (no sabe qué branch está activa; `bash_run` no
 * mantiene estado entre llamadas). En vez de intentar rastrear eso, se exige que un push SIEMPRE
 * nombre su destino explícito — que además es la forma más clara de todos modos.
 */
function isImplicitGitPush(argv: string[]): boolean {
  if (argv[0] !== 'git') return false
  const pushIndex = argv.indexOf('push')
  if (pushIndex === -1) return false
  const rest = argv.slice(pushIndex + 1).filter((token) => !token.startsWith('-'))
  if (rest.length === 0) return true // "git push" a secas
  if (rest.length === 1) return true // sólo el remoto, sin refspec ("git push origin")
  if (rest.length === 2 && rest[1] === 'HEAD') return true // "git push origin HEAD"
  return false
}

const FILE_OP_COMMANDS = new Set(['cp', 'mv', 'ln', 'chmod', 'chown', 'install', 'rsync'])

/** Separa por `/` Y por `=` — sin el segundo, `cp x --target-directory=.git/hooks` esquiva el
 *  chequeo: el segmento resultante de partir sólo por `/` es `--target-directory=.git`, que no
 *  es igual a `.git`. Partiendo también por `=` (para `--flag=valor`), el segmento queda `.git`
 *  limpio. */
function containsGitSegment(token: string): boolean {
  return token.split(/[/=]/).some((segment) => segment.toLowerCase() === '.git')
}

/**
 * `fs-tools` protege `.git` en `resolveSafePath`, pero `bash_run` es un camino COMPLETAMENTE
 * aparte al filesystem — ninguna tool de `fs-tools` está en el medio de `cp x .git/hooks/
 * pre-commit`. Si ese archivo termina siendo ejecutable (`chmod +x`), el próximo `git commit`/
 * `merge`/`checkout` corre lo que sea. Cualquier argumento de un comando de manipulación de
 * archivos que contenga un segmento `.git` (case-insensitive — ver `hasGitSegment` en
 * `fs-tools/shared.ts`, mismo criterio) se deniega.
 */
function isDangerousFileOpOnGit(argv: string[]): boolean {
  if (!FILE_OP_COMMANDS.has(argv[0])) return false
  return argv.slice(1).some(containsGitSegment)
}

export function isDenied(argv: string[], policy: BashPolicy): string | undefined {
  const patternMatch = policy.deny.find((pattern) => matchesPattern(argv, pattern))
  if (patternMatch) return patternMatch
  if (isDangerousGitPush(argv))
    return 'git push (main/master, --delete/--all/--mirror, o refspec force)'
  if (isImplicitGitPush(argv)) return 'git push sin nombrar la branch destino explícitamente'
  if (isDangerousGitTransport(argv))
    return 'git --upload-pack/--receive-pack/--exec (ejecuta un helper arbitrario)'
  if (isDangerousGitExecSubcommand(argv)) {
    return 'git rebase -x / bisect run / submodule foreach / filter-branch --tree-filter (ejecuta un comando arbitrario)'
  }
  if (isDangerousGitConfig(argv)) return 'git -c/config/--config-env (reconfigura git)'
  if (isDangerousFileOpOnGit(argv)) return `${argv[0]} apuntando a un segmento ".git"`
  return undefined
}

export function isAllowed(argv: string[], policy: BashPolicy): boolean {
  const allow = policy.allow ?? ['*']
  return allow.some((pattern) => matchesPattern(argv, pattern))
}

/**
 * Subset curado, NO exhaustivo — a diferencia del deny-list real de producción (200+ líneas en
 * `20-implementer.yaml`, con variantes posicionales para cubrir 2-3 flags delante de cada
 * comando). Cubre las categorías más obvias: shells anidados, borrado masivo, escalación,
 * push destructivo/forzado a `main`/`master`, credenciales del entorno, y exfiltración de red.
 * Un caller que necesite la cobertura real la arma con su propio `BashPolicy` — este default
 * es un punto de partida razonable, no una garantía de contención.
 */
export const DEFAULT_DENY_PATTERNS: string[] = [
  'bash *',
  'sh *',
  'zsh *',
  'sudo *',
  'su *',
  'rm',
  'rm *',
  'dd *',
  // Push FORZADO a cualquier branch (no sólo main/master — eso lo cubre `isDangerousGitPush`,
  // siempre activo, ver más abajo). Sigue siendo posicional: `git -C . push -u origin --force
  // otra-branch` con flags en otro orden puede colarse — ver README → "Límites honestos".
  'git push --force* *',
  'git push -f *',
  'git push * --force* *',
  'git push * -f *',
  // git -c / config / --config-env: chequeo DEDICADO (`isDangerousGitConfig`, siempre activo),
  // no patrones acá — una opción global antes (`git -C . -c ...`) esquivaba una posición fija.
  'git reset --hard *',
  'git clean *',
  'env',
  'env *',
  'printenv',
  'printenv *',
  'curl *',
  'wget *',
  'ssh *',
  'scp *',
  'nc *',
  // Intérpretes de propósito general — con uno de estos permitido, todo el resto de la lista es
  // decorativo (`python -c "import os; os.system(...)"` corre cualquier cosa). Denegados por
  // default; un caller que necesite correrlos arma su propia policy con el flag/subset que use.
  'python',
  'python *',
  'python3',
  'python3 *',
  'node',
  'node *',
  'ruby',
  'ruby *',
  'perl',
  'perl *',
  'bun',
  'bun *',
  'bunx *',
  'deno',
  'deno *',
  'tsx',
  'tsx *',
  'php',
  'php *',
  'lua',
  'lua *',
  // No tan obvios como "intérprete", pero corren código arbitrario igual: `awk
  // 'BEGIN{system("...")}'` ejecuta cualquier comando (y con ENVIRON lee el entorno aunque
  // env/printenv estén bloqueados); `sed`'s comando `e` (GNU) ejecuta shell.
  'awk',
  'awk *',
  'sed',
  'sed *',
  // Subcomandos de gestores de paquetes que corren un binario/script arbitrario — el resto del
  // package manager (install, test, run <script-del-repo>) se permite, sólo estos subcomandos
  // puntuales, pensados para correr algo por fuera del repo, se deniegan.
  'npx *',
  'pnpm dlx *',
  'pnpm exec *',
  'npm exec *',
  'yarn dlx *',
  // Vías de ejecución indirecta — corren un comando arbitrario en su propio argumento, así que
  // ningún patrón de arriba los ve.
  'xargs',
  'xargs *',
  // Wrappers que EJECUTAN otro binario pasado como argumento — cualquiera de estos vuelve a
  // abrir el acceso a todo lo de arriba (`nice bash -c ...`, `timeout 5 python3 -c ...`) porque
  // el deny-list sólo mira `argv[0]`, y acá `argv[0]` es el wrapper, inocuo, no lo que ejecuta.
  // Se deniega el wrapper entero — no hay forma de "ver a través" de uno sin ejecutarlo primero.
  'nice',
  'nice *',
  'timeout',
  'timeout *',
  'nohup',
  'nohup *',
  'stdbuf',
  'stdbuf *',
  'time',
  'time *',
  'watch',
  'watch *',
  'setsid',
  'setsid *',
  // `find` y `tar` enteros, no sólo sus flags peligrosos (`-exec`/`-delete`/`-ok`,
  // `--to-command`/`-I`/`--use-compress-program`): esos flags pueden ir en cualquier posición
  // entre los demás (`find . -name x -exec rm {} ';'`), GNU permite abreviarlos y pegarlos
  // (`-Ish`, `--to-com=...`), y perseguir cada variante es una carrera que no se gana con un
  // matcher posicional. Mismo criterio que `terraform init` en la policy real: no se puede
  // denegar todo y re-permitir la forma buena (`deny` gana sobre `allow`), así que se deniegan
  // enteros.
  'find',
  'find *',
  'tar',
  'tar *',
]
