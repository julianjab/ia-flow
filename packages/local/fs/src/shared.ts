import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Directorios que `fs_grep`/`fs_list` recursivos nunca bajan — ruido pesado o binario, nunca
 *  lo que un agente busca en un repo. */
export const SKIPPED_DIR_NAMES = new Set(['node_modules', '.git', 'dist', '.turbo', '.cache'])

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/** Case-INsensitive a propósito — en macOS/Windows (APFS/NTFS default) el filesystem no
 *  distingue mayúsculas, así que `.GIT/hooks/pre-commit` es EL MISMO archivo que
 *  `.git/hooks/pre-commit`. Comparar case-sensitive dejaría pasar esa variante en esos SO. */
function hasGitSegment(relPath: string): boolean {
  return relPath.split(sep).some((segment) => segment.toLowerCase() === '.git')
}

/**
 * Sube por los ancestros de `target` hasta encontrar uno que EXISTA de verdad (para un `fs_write`
 * a un archivo nuevo, o a directorios nuevos, `target` mismo — y varios de sus padres — todavía
 * no existen) y valida que, una vez resueltos los symlinks de esa parte real (`realpath`), el
 * path resultante siga DENTRO de `realBase`. Sin esto, un symlink DENTRO de `baseDir` que apunte
 * afuera pasaría el chequeo puramente léxico de `resolveSafePath` — ese chequeo sólo mira el
 * texto del path, nunca a dónde apunta un link real en disco.
 *
 * Devuelve el path FINAL ya resuelto (real ancestro + sufijo lexical de lo que todavía no
 * existe) — `resolveSafePath` opera sobre ESE valor, no sobre el lexical original. Es mitigación,
 * no una garantía TOCTOU-proof: entre este `realpath` y la lectura/escritura real todavía cabe
 * una carrera si otro proceso cambia un directorio del medio por un symlink en el medio — cerrar
 * eso del todo pide abrir con `O_NOFOLLOW` a nivel de file descriptor, fuera de alcance acá.
 */
async function resolveRealPath(
  realBase: string,
  target: string,
  baseDirLexical: string,
  originalInput: string,
): Promise<string> {
  let current = target
  let suffix = ''
  while (true) {
    try {
      const realCurrent = await realpath(current)
      const finalPath = suffix ? resolve(realCurrent, suffix) : realCurrent
      const rel = relative(realBase, finalPath)
      if (rel === '..' || rel.startsWith(`..${sep}`)) {
        throw new Error(`fs-tools: path fuera de baseDir (symlink): "${originalInput}"`)
      }
      // Repetido acá, sobre el path YA resuelto: un symlink DENTRO de baseDir que apunte a
      // `.git` (`ln -s .git g`) no tiene ".git" como segmento en el texto que mandó el modelo
      // (`g/hooks/pre-commit`) — sólo aparece después de seguir el link. El chequeo léxico de
      // `resolveSafePath` nunca lo vería.
      if (hasGitSegment(rel)) {
        throw new Error(`fs-tools: path pasa por ".git" (symlink) — rechazado: "${originalInput}"`)
      }
      return finalPath
    } catch (err) {
      if (!isEnoent(err)) throw err
      // `realpath` tira ENOENT tanto si `current` no existe DE VERDAD (walk-up legítimo — el
      // caso de `fs_write` a un archivo nuevo) como si `current` es un symlink ROTO que SÍ
      // existe como entrada pero apunta a un target que no existe — los dos casos dan el mismo
      // error, pero sólo el primero es seguro para seguir subiendo. `lstat` (que NO sigue el
      // link) distingue: si encuentra algo ahí, es un symlink roto — nunca confiable (podría
      // apuntar a cualquier lado, y `fs_write` lo seguiría al escribir), se rechaza directo en
      // vez de tratarlo como "todavía no existe".
      const brokenSymlink = await lstat(current)
        .then(() => true)
        .catch(() => false)
      if (brokenSymlink) {
        throw new Error(`fs-tools: "${originalInput}" pasa por un symlink roto — rechazado`)
      }
      if (current === baseDirLexical) throw err
      suffix = suffix ? join(basename(current), suffix) : basename(current)
      current = dirname(current)
    }
  }
}

/**
 * Resuelve `relativePath` contra `baseDir` y garantiza que el resultado sigue DENTRO de
 * `baseDir` — sin esto, `../../etc/passwd` (o un absoluto directo) se escapa del worktree que
 * el caller pensó que estaba conteniendo. Mismo criterio que `issuePath` en
 * `@ia-flow/github-tools`: los inputs de una tool son controlados por el modelo, nunca se
 * confían tal cual.
 *
 * Async (a diferencia de la versión anterior, puramente léxica) porque el chequeo de symlinks
 * necesita tocar disco (`realpath`) — ver `assertNoSymlinkEscape`.
 */
export async function resolveSafePath(baseDir: string, relativePath: string): Promise<string> {
  if (isAbsolute(relativePath)) {
    throw new Error(`fs-tools: path absoluto no permitido: "${relativePath}"`)
  }
  const resolvedBase = resolve(baseDir)
  const resolved = resolve(resolvedBase, relativePath)
  const rel = relative(resolvedBase, resolved)
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`fs-tools: path fuera de baseDir: "${relativePath}"`)
  }
  // `fs_write`/`fs_edit` con acceso a `.git/config` (`[core] pager = <cmd>`) o `.git/hooks/*`
  // consiguen ejecución arbitraria en el próximo `git log`/`git commit` — esto rompe la policy
  // ENTERA de `@ia-flow/shell-tools` desde el otro lado (fs-tools nunca sabe de `bash_run`, y
  // viceversa). En un worktree `.git` es un archivo, no un directorio, así que no aplicaría —
  // pero este paquete no asume que siempre corre en un worktree, así que el segmento se rechaza
  // siempre, exista o no.
  if (hasGitSegment(rel)) {
    throw new Error(`fs-tools: path pasa por ".git" — rechazado: "${relativePath}"`)
  }

  const realBase = await realpath(resolvedBase)
  return resolveRealPath(realBase, resolved, resolvedBase, relativePath)
}
