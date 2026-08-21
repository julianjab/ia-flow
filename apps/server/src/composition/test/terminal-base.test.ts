import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  type ProviderInput,
  assertWorktreeBranchMatches,
  createTerminalBase,
  pexec,
} from '@ia-flow/ai-providers'
import {
  DEFAULT_TERMINAL_SETTINGS,
  loadProviderConfig,
  saveProviderConfig,
} from '../../application/provider-config.js'
import { promptRepo, terminalBaseDeps } from '../container.js'

const { buildClaudeCommand } = createTerminalBase(terminalBaseDeps)

let originalDbConfig: Record<string, unknown> | null = null

// Repo git local con branch, usado como `cwd` en los tests de workflow para no
// depender del estado git del cwd real (en CI, actions/checkout deja HEAD
// detached — `resolveBaseBranch` retorna null y los tests pierden el shell
// wrapper de branch/worktree).
let sharedRepoDir = ''
let sharedRepo = ''

beforeAll(async () => {
  originalDbConfig = promptRepo.getProviderConfigBlob()
  const cfg = await loadProviderConfig()
  await saveProviderConfig({
    ...cfg,
    tmuxClaude: { ...DEFAULT_TERMINAL_SETTINGS },
    itermClaude: { ...DEFAULT_TERMINAL_SETTINGS },
  })

  sharedRepoDir = await mkdtemp(join(tmpdir(), 'iaflow-workflow-repo-'))
  sharedRepo = join(sharedRepoDir, 'repo')
  await pexec('git', ['init', '-q', '-b', 'main', sharedRepo])
  await pexec('git', [
    '-C',
    sharedRepo,
    '-c',
    'user.email=ci@ia-flow.test',
    '-c',
    'user.name=ia-flow ci',
    'commit',
    '--allow-empty',
    '-m',
    'init',
    '-q',
  ])
})

afterAll(async () => {
  if (originalDbConfig !== null) promptRepo.setProviderConfigBlob(originalDbConfig)
  else promptRepo.deleteProviderConfigBlob()
  if (sharedRepoDir) await rm(sharedRepoDir, { recursive: true, force: true })
  // Los tests de workflow=worktree crean worktrees reales bajo
  // /tmp/ia-flow/<basename(sharedRepo)>/. El basename es fijo ('repo'), así
  // que sin esto la corrida siguiente encontraría el directorio ocupado por
  // un repo que ya no existe y `ensureWorktree` fallaría.
  await rm(join('/tmp/ia-flow', basename(sharedRepo)), { recursive: true, force: true })
})

function baseInput(overrides: Partial<ProviderInput> = {}): ProviderInput {
  return {
    step: 'refine-functional',
    taskTitle: 'flag-test',
    taskDescription: 'd',
    taskType: 'feat',
    repos: [],
    repoPaths: {},
    prompt: 'hi',
    ...overrides,
  }
}

// El OAuth token del user machine podría inyectarse en runEnv y generar un
// --settings implícito, contaminando los cmd exactos. Lo neutralizamos.
const savedOauthToken = Bun.env.CLAUDE_CODE_OAUTH_TOKEN
beforeAll(() => {
  Bun.env.CLAUDE_CODE_OAUTH_TOKEN = ''
})
afterAll(() => {
  if (savedOauthToken !== undefined) Bun.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauthToken
  else delete Bun.env.CLAUDE_CODE_OAUTH_TOKEN
})

describe('buildClaudeCommand — terminal per-agent providerConfig', () => {
  it('emits all flags when providerConfig sets model and dangerouslySkipPermissions', async () => {
    const { cmd, promptFile, syspromptFile } = await buildClaudeCommand(
      baseInput({
        providerConfig: {
          model: 'claude-opus-4-7',
          dangerouslySkipPermissions: true,
        },
      }),
      'tmux-claude',
    )
    expect(cmd).toBe(
      `unset ANTHROPIC_API_KEY; claude --model claude-opus-4-7 --dangerously-skip-permissions --append-system-prompt-file "${syspromptFile}" < "${promptFile}"`,
    )
  })

  it('emits no flags when providerConfig is absent and no terminal defaults set', async () => {
    const { cmd, promptFile, syspromptFile } = await buildClaudeCommand(baseInput(), 'iterm-claude')
    expect(cmd).toBe(
      `unset ANTHROPIC_API_KEY; claude --append-system-prompt-file "${syspromptFile}" < "${promptFile}"`,
    )
  })

  it('emits only --dangerously-skip-permissions when only that flag is set', async () => {
    const { cmd, promptFile, syspromptFile } = await buildClaudeCommand(
      baseInput({
        providerConfig: { dangerouslySkipPermissions: true },
      }),
      'tmux-claude',
    )
    expect(cmd).toBe(
      `unset ANTHROPIC_API_KEY; claude --dangerously-skip-permissions --append-system-prompt-file "${syspromptFile}" < "${promptFile}"`,
    )
  })

  it('always appends the unattended-session note, independent of tools/mcpServers', async () => {
    const { syspromptFile } = await buildClaudeCommand(baseInput(), 'tmux-claude')
    const sys = await Bun.file(syspromptFile).text()
    expect(sys).toContain('Sesión desatendida')
    expect(sys).toContain('No preguntes')
    expect(sys).toContain('complete_task')
    expect(sys).toContain('fail_task')
  })

  it('escribe env de terminal defaults en settings.json y pasa --settings (no export en el shell)', async () => {
    const cfg = await loadProviderConfig()
    await saveProviderConfig({
      ...cfg,
      tmuxClaude: { ...DEFAULT_TERMINAL_SETTINGS, env: { FOO: 'bar', BAZ: 'qux' } },
    })
    try {
      const { cmd, settingsFile } = await buildClaudeCommand(baseInput(), 'tmux-claude')
      expect(settingsFile).toBeDefined()
      expect(cmd).toContain(`--settings "${settingsFile}"`)
      // No `export FOO=` en el cmd — env vive únicamente en settings.json.
      expect(cmd).not.toContain('export FOO')
      const written = JSON.parse(await Bun.file(settingsFile!).text())
      expect(written.env).toEqual({ FOO: 'bar', BAZ: 'qux' })
    } finally {
      await saveProviderConfig({ ...cfg, tmuxClaude: { ...DEFAULT_TERMINAL_SETTINGS } })
    }
  })

  it('no emite --settings cuando no hay env ni hook (evita archivo vacío)', async () => {
    const { cmd, settingsFile } = await buildClaudeCommand(baseInput(), 'tmux-claude')
    expect(settingsFile).toBeUndefined()
    expect(cmd).not.toContain('--settings')
  })

  it('registra los 6 hooks forwarder en settings.json cuando input.runId está presente', async () => {
    const { settingsFile } = await buildClaudeCommand(
      baseInput({ runId: 'run-abc' }),
      'tmux-claude',
    )
    expect(settingsFile).toBeDefined()
    const written = JSON.parse(await Bun.file(settingsFile!).text()) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    const hookNames = [
      'PreToolUse',
      'PostToolUse',
      'UserPromptSubmit',
      'Stop',
      'SubagentStop',
      'SessionStart',
    ]
    for (const name of hookNames) {
      const entry = written.hooks[name]
      expect(entry, `${name} debe estar registrado`).toBeDefined()
      expect(entry[0].hooks[0].command).toContain('hook-tool-use.ts')
      // Cada hook pasa su nombre como argv[2] al forwarder — así el script
      // arma el body /api/hook-events correcto por evento.
      expect(entry[0].hooks[0].command).toContain(` ${name}`)
    }
  })

  it('adds --mcp-config flag and writes JSON when providerConfig sets mcpServers', async () => {
    const { cmd, mcpConfigFile } = await buildClaudeCommand(
      baseInput({
        providerConfig: {
          mcpServers: {
            docs: { type: 'http', url: 'https://mcp.example/docs' },
          },
        },
      }),
      'tmux-claude',
    )
    expect(mcpConfigFile).toBeDefined()
    expect(cmd).toContain(`--mcp-config "${mcpConfigFile}"`)
    const written = JSON.parse(await Bun.file(mcpConfigFile!).text())
    expect(written).toEqual({
      mcpServers: { docs: { type: 'http', url: 'https://mcp.example/docs' } },
    })
  })

  it('adds --mcp-config for iterm-claude when mcpServers configured', async () => {
    const { cmd, mcpConfigFile } = await buildClaudeCommand(
      baseInput({
        providerConfig: {
          mcpServers: {
            local: { type: 'stdio', command: 'node', args: ['s.js'] },
          },
        },
      }),
      'iterm-claude',
    )
    expect(mcpConfigFile).toBeDefined()
    expect(cmd).toContain(`--mcp-config "${mcpConfigFile}"`)
  })

  it('does not add --mcp-config when mcpServers is empty or absent', async () => {
    const { cmd, mcpConfigFile } = await buildClaudeCommand(
      baseInput({ providerConfig: { mcpServers: {} } }),
      'tmux-claude',
    )
    expect(mcpConfigFile).toBeUndefined()
    expect(cmd).not.toContain('--mcp-config')

    const bare = await buildClaudeCommand(baseInput(), 'tmux-claude')
    expect(bare.mcpConfigFile).toBeUndefined()
    expect(bare.cmd).not.toContain('--mcp-config')
  })

  it('implement + workflow=branch → checks out task/<taskId>', async () => {
    // El texto de "git context" ya no lo arma terminal-base (lo inyecta el
    // orquestador via buildGitContext), pero el wrapper de shell sí — usa
    // task/<taskId> derivado de input.taskId, no del slug del título.
    const { cmd } = await buildClaudeCommand(
      baseInput({
        step: 'implement',
        taskId: 'ABC123',
        taskTitle: 'título con espacios y ácentos',
        cwd: sharedRepo,
        workflow: 'branch',
      }),
      'tmux-claude',
    )
    expect(cmd).toContain('git checkout -b task/ABC123')
    expect(cmd).toContain('git checkout task/ABC123')
    expect(cmd).not.toContain('feat/')
  })

  it('implement + workflow=worktree → crea el worktree y entra con cd, sin --worktree', async () => {
    // ia-flow materializa el worktree ANTES de lanzar claude y entra con `cd`.
    // No pasa `--worktree`: ese flag dispara WorktreeCreate, cuyos hooks se
    // mergean con los del usuario/proyecto y pueden crear un segundo worktree
    // con otra branch (ver el comentario en terminal/base.ts).
    const { cmd } = await buildClaudeCommand(
      baseInput({
        step: 'implement',
        taskId: 'XYZ789',
        issueNumber: 789,
        cwd: sharedRepo,
        workflow: 'worktree',
        branch: 'feat/add-invites-XYZ789',
      }),
      'tmux-claude',
    )

    expect(cmd).not.toContain('--worktree')
    // El directorio se nombra por el issue, no por el node id del source.
    expect(cmd).toContain('cd "/tmp/ia-flow/repo/.worktrees/task-789"')

    // Y el worktree existe de verdad, sobre la branch que eligió ia-flow.
    const { stdout } = await pexec('git', ['-C', sharedRepo, 'worktree', 'list', '--porcelain'])
    expect(stdout).toContain('.worktrees/task-789')
    expect(stdout).toContain('refs/heads/feat/add-invites-XYZ789')
  })

  it('implement + workflow=worktree sin input.branch → fallback task/<taskId>', async () => {
    const { cmd } = await buildClaudeCommand(
      baseInput({
        step: 'implement',
        taskId: 'WT1',
        issueNumber: 771,
        cwd: sharedRepo,
        workflow: 'worktree',
      }),
      'tmux-claude',
    )
    expect(cmd).toContain('cd "/tmp/ia-flow/repo/.worktrees/task-771"')
    const { stdout } = await pexec('git', ['-C', sharedRepo, 'worktree', 'list', '--porcelain'])
    expect(stdout).toContain('refs/heads/task/WT1')
  })

  it('implement + workflow=worktree sin issueNumber → nombre por slug del título', async () => {
    const { cmd } = await buildClaudeCommand(
      baseInput({
        step: 'implement',
        taskId: 'PVTI_lAHOAIgSic4Bf4pzzg3fXxk',
        taskTitle: 'Agregar botón de stop',
        cwd: sharedRepo,
        workflow: 'worktree',
        branch: 'feat/stop-button',
      }),
      'tmux-claude',
    )
    expect(cmd).toContain('.worktrees/task-agregar-boton-de-stop-g3fxxk')
  })

  it('workflow=worktree sin base branch resoluble → falla en vez de correr fuera del worktree', async () => {
    // buildGitContext ya le dijo al agente "estás dentro del worktree": si acá
    // degradáramos en silencio, la sesión commitearía en el clone real.
    // `resolveBaseBranch` devuelve null sólo si HEAD está detached Y no hay
    // main/master/develop a los que caer.
    const orphan = join(sharedRepoDir, 'orphan')
    await pexec('git', ['init', '-q', '-b', 'trunk', orphan])
    await pexec('git', [
      '-C',
      orphan,
      '-c',
      'user.email=ci@ia-flow.test',
      '-c',
      'user.name=ia-flow ci',
      'commit',
      '--allow-empty',
      '-m',
      'init',
      '-q',
    ])
    const { stdout: head } = await pexec('git', ['-C', orphan, 'rev-parse', 'HEAD'])
    await pexec('git', ['-C', orphan, 'checkout', '-q', '--detach', head.trim()])
    await pexec('git', ['-C', orphan, 'branch', '-D', 'trunk'])

    await expect(
      buildClaudeCommand(
        baseInput({
          step: 'implement',
          taskId: 'DET1',
          issueNumber: 555,
          cwd: orphan,
          workflow: 'worktree',
          branch: 'feat/detached',
        }),
        'tmux-claude',
      ),
    ).rejects.toThrow(/base branch/)
  })

  it('worktree registrado pero con el directorio borrado → lo recrea', async () => {
    // Regresión: `git worktree list` sigue listando worktrees prunables. Si los
    // diéramos por buenos, el cmd sería `cd "<path inexistente>" && claude …`,
    // el && cortaría y la sesión nunca arrancaría, sin error en la UI.
    const input = baseInput({
      step: 'implement',
      taskId: 'PRUNE1',
      issueNumber: 606,
      cwd: sharedRepo,
      workflow: 'worktree',
      branch: 'feat/prunable',
    })
    await buildClaudeCommand(input, 'tmux-claude')
    const wtPath = '/tmp/ia-flow/repo/.worktrees/task-606'
    await rm(wtPath, { recursive: true, force: true }) // registro queda stale

    await buildClaudeCommand(input, 'tmux-claude')

    expect(existsSync(wtPath)).toBe(true)
  })

  it('branch ya checkouteada en otro worktree (legacy) → error que nombra al viejo', async () => {
    // Tasks en vuelo creadas antes del rename tienen su worktree en
    // `.worktrees/<taskId>`. Sin este chequeo fallarían los 4 fallbacks de git
    // con un volcado que no menciona el worktree culpable.
    const legacy = '/tmp/ia-flow/repo/.worktrees/LEGACY-TASK-ID'
    await pexec('git', ['-C', sharedRepo, 'worktree', 'add', '-b', 'feat/legacy', legacy, 'main'])

    await expect(
      buildClaudeCommand(
        baseInput({
          step: 'implement',
          taskId: 'LEGACY-TASK-ID',
          issueNumber: 707,
          cwd: sharedRepo,
          workflow: 'worktree',
          branch: 'feat/legacy',
        }),
        'tmux-claude',
      ),
    ).rejects.toThrow(/worktree remove --force/)
  })

  it('workflow=worktree ya no registra hooks WorktreeCreate/WorktreeRemove', async () => {
    const { settingsFile } = await buildClaudeCommand(
      baseInput({
        step: 'implement',
        taskId: 'NOHOOK1',
        issueNumber: 901,
        cwd: sharedRepo,
        workflow: 'worktree',
        branch: 'feat/no-hook',
      }),
      'tmux-claude',
    )
    if (settingsFile) {
      const settings = JSON.parse(await Bun.file(settingsFile).text()) as {
        hooks?: Record<string, unknown>
      }
      expect(settings.hooks?.WorktreeCreate).toBeUndefined()
      expect(settings.hooks?.WorktreeRemove).toBeUndefined()
    }
  })

  it('implement + workflow=main → no branch checkout, no --worktree', async () => {
    const { cmd } = await buildClaudeCommand(
      baseInput({
        step: 'implement',
        taskId: 'MAIN1',
        cwd: process.cwd(),
        workflow: 'main',
      }),
      'tmux-claude',
    )
    expect(cmd).not.toContain('git checkout -b')
    expect(cmd).not.toContain('--worktree')
  })

  it('ignores providerConfig with fields foreign to the terminal provider schema', async () => {
    // Under the open providerConfig shape, per-provider strictness lives in
    // each provider file. The terminal schema is strict and knows only
    // `model` and `dangerouslySkipPermissions`. Extra keys make parsing
    // fail and the override is dropped (safe default).
    const { cmd, promptFile, syspromptFile } = await buildClaudeCommand(
      baseInput({
        providerConfig: { effort: 'high', taskBudgetTokens: 30000 },
      }),
      'tmux-claude',
    )
    expect(cmd).toBe(
      `unset ANTHROPIC_API_KEY; claude --append-system-prompt-file "${syspromptFile}" < "${promptFile}"`,
    )
  })

  it('workflow != worktree → no WorktreeRemove hook in settings.json', async () => {
    const { settingsFile } = await buildClaudeCommand(
      baseInput({
        step: 'implement',
        taskId: 'NO_RMV',
        cwd: sharedRepo,
        workflow: 'branch',
      }),
      'tmux-claude',
    )
    // workflow=branch generates no settings file (no hook, no env).
    // If it does generate one, WorktreeRemove must be absent.
    if (settingsFile) {
      const settings = JSON.parse(await Bun.file(settingsFile).text()) as {
        hooks?: { WorktreeRemove?: unknown }
      }
      expect(settings.hooks?.WorktreeRemove).toBeUndefined()
    }
  })

  it('assertWorktreeBranchMatches → lanza si el worktree existente tiene otra branch', async () => {
    // Setup: repo desnudo con un worktree preexistente que apunta a una branch
    // "legacy" — el escenario real que motivó el precheck (renombramos las
    // branches nuevas y quedaron worktrees stale con el naming viejo). Sin
    // remote configurado, isWorktreeSafeToRemove no puede confirmar "seguro" →
    // conserva el throw actual.
    const dir = await mkdtemp(join(tmpdir(), 'iaflow-wt-precheck-'))
    const repo = join(dir, 'repo')
    const worktreeParent = join(dir, 'wt', '.worktrees')
    const worktreePath = join(worktreeParent, 'TASK1')
    try {
      await pexec('git', ['init', '-q', '-b', 'main', repo])
      await pexec('git', [
        '-C',
        repo,
        '-c',
        'user.email=ci@ia-flow.test',
        '-c',
        'user.name=ia-flow ci',
        'commit',
        '--allow-empty',
        '-m',
        'init',
        '-q',
      ])
      await pexec('git', ['-C', repo, 'worktree', 'add', '-b', 'feat/legacy-name', worktreePath])

      // (1) Branch esperada distinta → falla con mensaje procesable.
      await expect(assertWorktreeBranchMatches(repo, 'TASK1', 'feat/new-name')).rejects.toThrow(
        /ya existe.*feat\/legacy-name.*se esperaba "feat\/new-name"/,
      )

      // (2) Branch esperada coincide → no-op.
      await expect(
        assertWorktreeBranchMatches(repo, 'TASK1', 'feat/legacy-name'),
      ).resolves.toBeUndefined()

      // (3) TaskId sin worktree registrado → no-op.
      await expect(
        assertWorktreeBranchMatches(repo, 'TASK_UNKNOWN', 'anything'),
      ).resolves.toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('assertWorktreeBranchMatches → recicla automáticamente un worktree stale sin trabajo en riesgo', async () => {
    // Worktree stale (branch distinta a la esperada) pero SIN cambios sin
    // commitear ni commits locales por delante de origin/<branch> — igual
    // criterio que WorkspaceManager.isWorktreeSafeToRemove. A diferencia del
    // test anterior, acá SÍ configuramos un remote real (bare repo local) y
    // pusheamos la branch legacy, para que `git ls-remote` + `git log
    // origin/<branch>..HEAD` puedan confirmar "sin commits por delante" — sin
    // remote, ese chequeo siempre cae en "no seguro" (ver el test anterior).
    // Debe auto-removerse (worktree + branch) y resolver sin lanzar, dejando
    // el terreno libre para que el hook WorktreeCreate recree el worktree
    // sobre expectedBranch.
    const dir = await mkdtemp(join(tmpdir(), 'iaflow-wt-autorecycle-'))
    const originPath = join(dir, 'origin.git')
    const repo = join(dir, 'repo')
    const worktreePath = join(dir, 'wt', '.worktrees', 'TASK_CLEAN')
    try {
      await pexec('git', ['init', '-q', '--bare', originPath])
      await pexec('git', ['init', '-q', '-b', 'main', repo])
      await pexec('git', ['-C', repo, 'remote', 'add', 'origin', originPath])
      await pexec('git', [
        '-C',
        repo,
        '-c',
        'user.email=ci@ia-flow.test',
        '-c',
        'user.name=ia-flow ci',
        'commit',
        '--allow-empty',
        '-m',
        'init',
        '-q',
      ])
      await pexec('git', ['-C', repo, 'push', '-q', 'origin', 'main'])
      await pexec('git', ['-C', repo, 'worktree', 'add', '-b', 'task/legacy-clean', worktreePath])
      // Pushea la branch legacy — el worktree queda exactamente al día con
      // origin/task/legacy-clean, sin commits locales por delante.
      await pexec('git', ['-C', worktreePath, 'push', '-q', '-u', 'origin', 'task/legacy-clean'])

      await expect(
        assertWorktreeBranchMatches(repo, 'TASK_CLEAN', 'chore/renamed-branch'),
      ).resolves.toBeUndefined()

      // El worktree fue removido del registro de git.
      const list = await pexec('git', ['-C', repo, 'worktree', 'list', '--porcelain'])
      expect(list.stdout).not.toContain('TASK_CLEAN')

      // La branch obsoleta también fue borrada.
      const branches = await pexec('git', ['-C', repo, 'branch', '--list'])
      expect(branches.stdout).not.toContain('task/legacy-clean')

      // Un `worktree add` posterior sobre expectedBranch funciona limpio —
      // exactamente el flujo que el hook WorktreeCreate ejecuta después.
      await expect(
        pexec('git', ['-C', repo, 'worktree', 'add', '-b', 'chore/renamed-branch', worktreePath]),
      ).resolves.toBeDefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('assertWorktreeBranchMatches → NO recicla un worktree stale con cambios sin commitear', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iaflow-wt-dirty-'))
    const repo = join(dir, 'repo')
    const worktreePath = join(dir, 'wt', '.worktrees', 'TASK_DIRTY')
    try {
      await pexec('git', ['init', '-q', '-b', 'main', repo])
      await pexec('git', [
        '-C',
        repo,
        '-c',
        'user.email=ci@ia-flow.test',
        '-c',
        'user.name=ia-flow ci',
        'commit',
        '--allow-empty',
        '-m',
        'init',
        '-q',
      ])
      await pexec('git', ['-C', repo, 'worktree', 'add', '-b', 'task/legacy-dirty', worktreePath])
      await Bun.write(join(worktreePath, 'uncommitted.txt'), 'trabajo sin commitear')

      await expect(
        assertWorktreeBranchMatches(repo, 'TASK_DIRTY', 'chore/renamed-branch'),
      ).rejects.toThrow(/ya existe.*task\/legacy-dirty.*se esperaba "chore\/renamed-branch"/)

      // El worktree y la branch siguen intactos — nada se borró.
      const list = await pexec('git', ['-C', repo, 'worktree', 'list', '--porcelain'])
      expect(list.stdout).toContain('TASK_DIRTY')
      const branches = await pexec('git', ['-C', repo, 'branch', '--list'])
      expect(branches.stdout).toContain('task/legacy-dirty')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('assertWorktreeBranchMatches → NO recicla un worktree stale con commits locales sin pushear', async () => {
    // Sin remote configurado: el helper cae en la rama "remote ausente" y
    // compara HEAD contra origin/HEAD — acá tampoco existe origin/HEAD, así
    // que `git log origin/HEAD..HEAD` falla y el chequeo trata eso como "no
    // seguro" (best-effort → conserva el throw).
    const dir = await mkdtemp(join(tmpdir(), 'iaflow-wt-unpushed-'))
    const repo = join(dir, 'repo')
    const worktreePath = join(dir, 'wt', '.worktrees', 'TASK_UNPUSHED')
    try {
      await pexec('git', ['init', '-q', '-b', 'main', repo])
      await pexec('git', [
        '-C',
        repo,
        '-c',
        'user.email=ci@ia-flow.test',
        '-c',
        'user.name=ia-flow ci',
        'commit',
        '--allow-empty',
        '-m',
        'init',
        '-q',
      ])
      await pexec('git', [
        '-C',
        repo,
        'worktree',
        'add',
        '-b',
        'task/legacy-unpushed',
        worktreePath,
      ])
      await pexec('git', [
        '-C',
        worktreePath,
        '-c',
        'user.email=ci@ia-flow.test',
        '-c',
        'user.name=ia-flow ci',
        'commit',
        '--allow-empty',
        '-m',
        'local work not pushed anywhere',
        '-q',
      ])

      await expect(
        assertWorktreeBranchMatches(repo, 'TASK_UNPUSHED', 'chore/renamed-branch'),
      ).rejects.toThrow(/ya existe.*task\/legacy-unpushed.*se esperaba "chore\/renamed-branch"/)

      const list = await pexec('git', ['-C', repo, 'worktree', 'list', '--porcelain'])
      expect(list.stdout).toContain('TASK_UNPUSHED')
      const branches = await pexec('git', ['-C', repo, 'branch', '--list'])
      expect(branches.stdout).toContain('task/legacy-unpushed')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('el user prompt es exclusivamente input.prompt, sin contaminación de tools', async () => {
    const { promptFile } = await buildClaudeCommand(
      baseInput({ prompt: 'contenido crudo del agente' }),
      'tmux-claude',
    )
    const userPrompt = await Bun.file(promptFile).text()
    expect(userPrompt).toBe('contenido crudo del agente')
  })

  it('adds a synthetic ia-flow-tools MCP entry pointing at /api/mcp when the agent declares tools', async () => {
    const { mcpConfigFile } = await buildClaudeCommand(
      baseInput({ tools: ['update_issue_body', 'complete_task'] }),
      'tmux-claude',
    )
    expect(mcpConfigFile).toBeDefined()
    const written = JSON.parse(await Bun.file(mcpConfigFile!).text())
    const entry = written.mcpServers['ia-flow-tools']
    expect(entry.type).toBe('http')
    expect(entry.url).toContain('/api/mcp?tools=')
    expect(entry.url).toContain('update_issue_body')
    expect(entry.url).toContain('complete_task')
  })

  it('merges the synthetic ia-flow-tools entry alongside catalog mcpServers', async () => {
    const { mcpConfigFile } = await buildClaudeCommand(
      baseInput({
        tools: ['update_issue_body'],
        providerConfig: {
          mcpServers: { docs: { type: 'http', url: 'https://mcp.example/docs' } },
        },
      }),
      'tmux-claude',
    )
    expect(mcpConfigFile).toBeDefined()
    const written = JSON.parse(await Bun.file(mcpConfigFile!).text())
    expect(written.mcpServers.docs).toEqual({ type: 'http', url: 'https://mcp.example/docs' })
    expect(written.mcpServers['ia-flow-tools']).toBeDefined()
  })

  it('does not add the synthetic mcp entry when the agent declares no tools', async () => {
    const { mcpConfigFile } = await buildClaudeCommand(baseInput(), 'tmux-claude')
    expect(mcpConfigFile).toBeUndefined()
  })
})
