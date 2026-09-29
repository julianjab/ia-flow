import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveSafePath } from '../shared.js'

let baseDir: string
let outsideDir: string

beforeEach(async () => {
  // realpath: en macOS $TMPDIR resuelve bajo un symlink (/tmp -> /private/tmp); resolveSafePath
  // ahora devuelve el path YA resuelto (ver "mitigación TOCTOU" en shared.ts), así que hay que
  // comparar contra eso, no contra el string crudo que devuelve mkdtemp.
  baseDir = await realpath(await mkdtemp(join(tmpdir(), 'fs-tools-shared-base-')))
  outsideDir = await realpath(await mkdtemp(join(tmpdir(), 'fs-tools-shared-outside-')))
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
  await rm(outsideDir, { recursive: true, force: true })
})

describe('resolveSafePath', () => {
  it('resuelve un path relativo dentro de baseDir', async () => {
    await writeFile(join(baseDir, 'a.txt'), 'x', 'utf-8')
    expect(await resolveSafePath(baseDir, 'a.txt')).toBe(join(baseDir, 'a.txt'))
  })

  it('resuelve "." a baseDir mismo', async () => {
    expect(await resolveSafePath(baseDir, '.')).toBe(join(baseDir))
  })

  it('rechaza un path absoluto', async () => {
    await expect(resolveSafePath(baseDir, '/etc/passwd')).rejects.toThrow('absoluto')
  })

  it('rechaza un path traversal que se escapa de baseDir', async () => {
    await expect(resolveSafePath(baseDir, '../../etc/passwd')).rejects.toThrow('fuera de baseDir')
  })

  it('rechaza un traversal disfrazado dentro de un subpath', async () => {
    await expect(resolveSafePath(baseDir, 'src/../../secrets')).rejects.toThrow('fuera de baseDir')
  })

  it('permite un path a un archivo que todavía no existe (caso fs_write)', async () => {
    expect(await resolveSafePath(baseDir, 'nuevo.txt')).toBe(join(baseDir, 'nuevo.txt'))
  })

  it('permite un path anidado donde ningún ancestro existe todavía', async () => {
    expect(await resolveSafePath(baseDir, 'a/b/c.txt')).toBe(join(baseDir, 'a/b/c.txt'))
  })

  it('rechaza un symlink DENTRO de baseDir que apunta a un archivo afuera', async () => {
    await writeFile(join(outsideDir, 'secret.txt'), 'shh', 'utf-8')
    await symlink(join(outsideDir, 'secret.txt'), join(baseDir, 'link.txt'))

    await expect(resolveSafePath(baseDir, 'link.txt')).rejects.toThrow('symlink')
  })

  it('rechaza un path DENTRO de un symlink a directorio que apunta afuera', async () => {
    await mkdir(join(outsideDir, 'nested'))
    await writeFile(join(outsideDir, 'nested', 'secret.txt'), 'shh', 'utf-8')
    await symlink(outsideDir, join(baseDir, 'link-dir'))

    await expect(resolveSafePath(baseDir, 'link-dir/nested/secret.txt')).rejects.toThrow('symlink')
  })

  it('rechaza un symlink ROTO (apunta a un target que no existe) en vez de tratarlo como path nuevo', async () => {
    // ln -s ~/.ssh/authorized_keys evil — el target no existe todavía, así que realpath(evil)
    // tira ENOENT igual que un path genuinamente nuevo; sin lstat() de por medio, el walk-up
    // lo trataría como "archivo nuevo dentro de baseDir" y fs_write escribiría siguiendo el
    // link, afuera.
    await symlink(join(outsideDir, 'no-existe-todavia.txt'), join(baseDir, 'evil.txt'))

    await expect(resolveSafePath(baseDir, 'evil.txt')).rejects.toThrow('symlink roto')
  })

  it('rechaza cualquier path que pase por un segmento ".git" — escribirle ahí compromete bash_run', async () => {
    await expect(resolveSafePath(baseDir, '.git/config')).rejects.toThrow('.git')
    await expect(resolveSafePath(baseDir, '.git/hooks/pre-commit')).rejects.toThrow('.git')
    await expect(resolveSafePath(baseDir, 'sub/.git/config')).rejects.toThrow('.git')
  })

  it('rechaza ".git" sin distinguir mayúsculas — macOS/Windows resuelven ".GIT" al mismo directorio', async () => {
    await expect(resolveSafePath(baseDir, '.GIT/config')).rejects.toThrow('.git')
    await expect(resolveSafePath(baseDir, '.Git/hooks/pre-commit')).rejects.toThrow('.git')
  })

  it('rechaza un symlink que apunta a ".git" aunque el path que mandó el modelo no diga ".git"', async () => {
    // ln -s .git g && fs_write("g/hooks/pre-commit", ...) — el texto de entrada ("g/hooks/...")
    // no tiene ".git" como segmento; sólo aparece DESPUÉS de resolver el symlink.
    await mkdir(join(baseDir, '.git'))
    await symlink(join(baseDir, '.git'), join(baseDir, 'g'))

    await expect(resolveSafePath(baseDir, 'g/hooks/pre-commit')).rejects.toThrow('.git')
  })

  it('permite un symlink que apunta a otro lugar DENTRO de baseDir', async () => {
    await writeFile(join(baseDir, 'real.txt'), 'x', 'utf-8')
    await symlink(join(baseDir, 'real.txt'), join(baseDir, 'alias.txt'))

    // Devuelve el path REAL (el symlink resuelto), no el lexical del symlink — ver la nota de
    // "mitigación TOCTOU" en resolveRealPath.
    await expect(resolveSafePath(baseDir, 'alias.txt')).resolves.toBe(join(baseDir, 'real.txt'))
  })
})
