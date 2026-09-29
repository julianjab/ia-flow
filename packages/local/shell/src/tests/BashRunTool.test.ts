import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BashRunTool } from '../BashRunTool.js'

let baseDir: string

beforeEach(async () => {
  // realpath: en macOS $TMPDIR resuelve bajo un symlink (/tmp -> /private/tmp) — `pwd` (y
  // cualquier proceso real) devuelve el path YA resuelto, así que comparamos contra eso.
  baseDir = await realpath(await mkdtemp(join(tmpdir(), 'shell-tools-bashrun-')))
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

describe('bash_run', () => {
  it('corre un comando permitido y devuelve stdout', async () => {
    const tool = new BashRunTool({ baseDir, policy: { deny: [] } })

    const result = JSON.parse(await tool.handler({ command: 'echo hola' }))

    expect(result.status).toBe('exit 0')
    expect(result.stdout.trim()).toBe('hola')
  })

  it('rechaza un comando denegado por la policy sin ejecutarlo', async () => {
    const tool = new BashRunTool({ baseDir, policy: { deny: ['rm *'] } })

    await expect(tool.handler({ command: 'rm -rf /' })).rejects.toThrow('denegado')
  })

  it('rechaza un comando fuera de un allowlist explícito', async () => {
    const tool = new BashRunTool({ baseDir, policy: { allow: ['echo *'], deny: [] } })

    await expect(tool.handler({ command: 'ls' })).rejects.toThrow('allowlist')
  })

  it('rechaza un input sin command o con claves de más, sin ejecutar nada', async () => {
    const tool = new BashRunTool({ baseDir, policy: { deny: [] } })

    await expect(tool.handler({})).rejects.toThrow(/bash_run: input inválido[\s\S]*→ at command/)
    await expect(tool.handler({ command: 'echo hola', cwd: '/' })).rejects.toThrow(
      /Unrecognized key: "cwd"/,
    )
  })

  it('rechaza un binario invocado por path absoluto — no puede saltarse la deny-list así', async () => {
    const tool = new BashRunTool({ baseDir, policy: { deny: ['rm *'] } })

    await expect(tool.handler({ command: '/bin/rm -rf /' })).rejects.toThrow('path')
  })

  it('rechaza un binario invocado por path relativo', async () => {
    const tool = new BashRunTool({ baseDir, policy: { deny: [] } })

    await expect(tool.handler({ command: './evil.sh' })).rejects.toThrow('path')
    await expect(tool.handler({ command: 'bin/evil' })).rejects.toThrow('path')
  })

  it('corre en baseDir — un comando que depende del cwd lo confirma', async () => {
    const tool = new BashRunTool({ baseDir, policy: { deny: [] } })

    const result = JSON.parse(await tool.handler({ command: 'pwd' }))

    expect(result.stdout.trim()).toBe(baseDir)
  })

  it('reporta un exit code no-cero sin tirar — el modelo decide qué hacer con eso', async () => {
    const tool = new BashRunTool({ baseDir, policy: { deny: [] } })

    const result = JSON.parse(await tool.handler({ command: 'ls no-existe-seguro' }))

    expect(result.status).not.toBe('exit 0')
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('corta un comando que produce salida infinita apenas supera maxOutputBytes', async () => {
    const tool = new BashRunTool({ baseDir, policy: { deny: [] }, maxOutputBytes: 32 })

    const result = JSON.parse(await tool.handler({ command: 'yes' }))

    expect(result.stdout.length).toBeLessThan(200) // truncado, no las decenas de MB que "yes" tiraría
    expect(result.stdout).toContain('truncado')
    expect(result.status).not.toBe('exit 0') // lo matamos con SIGKILL, no terminó solo
  }, 10_000)

  it('mata el proceso (y no cuelga la promise) si supera timeoutMs', async () => {
    const tool = new BashRunTool({ baseDir, policy: { deny: [] }, timeoutMs: 200 })
    const start = Date.now()

    const result = JSON.parse(await tool.handler({ command: 'sleep 30' }))

    expect(Date.now() - start).toBeLessThan(5000) // no esperó los 30s del sleep
    expect(result.status).not.toBe('exit 0')
  }, 10_000)

  it('un corte por tiempo dice que fue por tiempo, y cuánto más se puede pedir', async () => {
    const tool = new BashRunTool({
      baseDir,
      policy: { deny: [] },
      timeoutMs: 200,
      maxTimeoutMs: 5_000,
    })
    const result = JSON.parse(await tool.handler({ command: 'sleep 30' }))
    expect(result.status).toMatch(/^timeout: se cortó a los 0 s \(podés pedir hasta 5 s/)
    expect(tool.description).toContain('pedí más con `timeoutMs`, hasta 5 s')
  }, 10_000)

  it('el agente puede pedir más tiempo por comando, sin pasar el máximo', async () => {
    const tool = new BashRunTool({
      baseDir,
      policy: { deny: [] },
      timeoutMs: 100,
      maxTimeoutMs: 1_500,
    })
    // Con lo pedido termina solo.
    expect(JSON.parse(await tool.handler({ command: 'sleep 0.5', timeoutMs: 1_000 })).status).toBe(
      'exit 0',
    )
    // Pedir más que el máximo se recorta al máximo.
    const start = Date.now()
    const capped = JSON.parse(await tool.handler({ command: 'sleep 30', timeoutMs: 60_000 }))
    expect(Date.now() - start).toBeLessThan(5_000)
    expect(capped.status).toMatch(/es el máximo/)
  }, 10_000)

  it('sin maxTimeoutMs el agente no puede estirarlo', async () => {
    const tool = new BashRunTool({ baseDir, policy: { deny: [] }, timeoutMs: 200 })
    const start = Date.now()
    const result = JSON.parse(await tool.handler({ command: 'sleep 30', timeoutMs: 60_000 }))
    expect(Date.now() - start).toBeLessThan(5_000)
    expect(result.status).toMatch(/^timeout/)
    expect(tool.description).not.toContain('timeoutMs')
  }, 10_000)

  it('stdin va a /dev/null, no queda un pipe abierto — un comando que lee stdin no cuelga hasta timeoutMs', async () => {
    const tool = new BashRunTool({ baseDir, policy: { deny: [] } }) // default timeoutMs: 60s

    const result = JSON.parse(await tool.handler({ command: 'cat' }))

    // "cat" sin argumento lee de stdin — con stdin en /dev/null recibe EOF al toque en vez de
    // colgarse esperando que alguien escriba.
    expect(result.status).toBe('exit 0')
    expect(result.stdout).toBe('')
  }, 5_000)

  it('NO hereda el entorno completo del proceso — una var fuera del subset seguro no llega', async () => {
    process.env.FS_TOOLS_TEST_SECRET = 'no-deberia-verse'
    try {
      const tool = new BashRunTool({ baseDir, policy: { deny: [] } })

      const result = JSON.parse(await tool.handler({ command: 'printenv FS_TOOLS_TEST_SECRET' }))

      expect(result.stdout.trim()).toBe('')
      expect(result.status).not.toBe('exit 0') // printenv sale con status !=0 si la var no está
    } finally {
      // biome-ignore lint/performance/noDelete: `= undefined` NO borra la var en Node — coerciona a la string "undefined", que seguiría ahí para el resto de la suite.
      delete process.env.FS_TOOLS_TEST_SECRET
    }
  })

  it('normaliza argv[0] a minúsculas antes de evaluar la policy — PATH resuelve sin distinguir mayúsculas en macOS/Windows', async () => {
    const tool = new BashRunTool({ baseDir, policy: { deny: ['bash *'] } })

    await expect(tool.handler({ command: 'Bash -c "id"' })).rejects.toThrow('denegado')
  })

  it('un env explícito reemplaza el default y sí llega al proceso', async () => {
    const tool = new BashRunTool({
      baseDir,
      policy: { deny: [] },
      env: { PATH: process.env.PATH ?? '', FOO: 'bar' },
    })

    const result = JSON.parse(await tool.handler({ command: 'printenv FOO' }))

    expect(result.stdout.trim()).toBe('bar')
  })
})
