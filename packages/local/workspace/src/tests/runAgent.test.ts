import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createEvent,
  EventBus,
  type PipelineExecutionContext,
  ProviderRegistry,
  type ProviderRunContext,
} from '@ia-flow/agent-engine'
import { describe, expect, it } from 'vitest'
import { parseClaudeAgent, RunAgentAction, WorkspaceSession } from '../actions/index.js'
import type { WorkspaceManager } from '../WorkspaceManager.js'

const dir = mkdtempSync(join(tmpdir(), 'ws-run-agent-'))
mkdirSync(join(dir, '.claude', 'agents'), { recursive: true })
writeFileSync(join(dir, 'notes.md'), 'la clave es 42\n')
writeFileSync(
  join(dir, '.claude', 'agents', 'reader.md'),
  '---\nname: reader\ndescription: Lee archivos y resume\ntools: Read, Grep, WebFetch\nmodel: haiku\n---\nSos un lector minucioso.\n',
)
writeFileSync(
  join(dir, '.claude', 'agents', 'fixer.md'),
  '---\nname: fixer\ndescription: Arregla cosas\n---\nArreglás.\n',
)
writeFileSync(join(dir, '.claude', 'agents', 'broken.md'), 'sin frontmatter')

const session = new WorkspaceSession(
  {
    ensureLocalClone: async () => '/repos/o/r',
    getOrCreateWorktree: async () => ({ path: dir, branch: 'ia-flow/7' }),
  } as unknown as WorkspaceManager,
  () => ({
    task: { id: 'o/r#7', issueNumber: 7 },
    repo: { name: 'r', githubOwner: 'o', githubRepo: 'r' },
  }),
)

const ctx = (): PipelineExecutionContext => ({
  event: createEvent('build', {}),
  steps: {},
  bus: new EventBus(),
  pipelineId: 'build',
})

/** Un provider que lee `notes.md` con la tool que le dieron y entrega el resumen. */
function reading(seen: ProviderRunContext[]) {
  return new ProviderRegistry().register({
    id: 'fake',
    run: async (run) => {
      seen.push(run)
      const read = run.tools.find((tool) => tool.name === 'fs_read')
      const text = read ? await read.handler({ path: 'notes.md' }) : 'sin fs_read'
      await run.tools
        .find((tool) => tool.name === 'submit_done')
        ?.handler({ result: { summary: `leí: ${text.trim()}` } })
      return { outcome: 'success' }
    },
  })
}

describe('parseClaudeAgent', () => {
  it('reads the frontmatter and the body, with tools as a list or a comma string', () => {
    expect(
      parseClaudeAgent('---\nname: a\ndescription: d\ntools: [Read, Bash]\n---\ncuerpo'),
    ).toEqual({ name: 'a', description: 'd', tools: ['Read', 'Bash'], prompt: 'cuerpo' })
    expect(parseClaudeAgent('---\nname: a\ntools: Read, Grep\n---\n')?.tools).toEqual([
      'Read',
      'Grep',
    ])
    expect(parseClaudeAgent('sin frontmatter')).toBeUndefined()
    expect(parseClaudeAgent('---\ndescription: sin nombre\n---\n')).toBeUndefined()
  })
})

describe('run_agent', () => {
  it('lists the repo sub-agents when no agent is given', async () => {
    const action = new RunAgentAction(session, { provider: 'fake', registry: reading([]) })
    const list = await action.asTool(ctx()).handler({})
    expect(list).toContain('- fixer: Arregla cosas')
    expect(list).toContain('- reader: Lee archivos y resume')
    expect(list).not.toContain('broken')
  })

  it('runs the sub-agent on the same worktree, with its prompt, model and translated tools', async () => {
    const seen: ProviderRunContext[] = []
    const action = new RunAgentAction(session, { provider: 'fake', registry: reading(seen) })

    const summary = await action
      .asTool(ctx())
      .handler({ agent: 'reader', brief: 'Buscá la clave en notes.md' })

    expect(summary).toBe('leí: la clave es 42')
    expect(seen[0]?.prompt).toBe('Buscá la clave en notes.md')
    expect(seen[0]?.systemPrompts).toEqual(['Sos un lector minucioso.'])
    expect(seen[0]?.providerConfig).toEqual({ model: 'claude-haiku-4-5' })
    const tools = seen[0]?.tools.map((tool) => tool.name) ?? []
    expect(tools).toEqual(expect.arrayContaining(['fs_read', 'fs_grep']))
    expect(tools).not.toContain('run_agent')
    expect(tools.some((name) => name.startsWith('WebFetch'))).toBe(false)
  })

  it('a sub-agent without declared tools gets them all — but only the read-only ones unless write', async () => {
    const seen: ProviderRunContext[] = []
    await new RunAgentAction(session, { provider: 'fake', registry: reading(seen) })
      .asTool(ctx())
      .handler({ agent: 'fixer', brief: 'x' })
    await new RunAgentAction(session, { provider: 'fake', registry: reading(seen), write: true })
      .asTool(ctx())
      .handler({ agent: 'fixer', brief: 'x' })

    const names = (i: number) => seen[i]?.tools.map((tool) => tool.name) ?? []
    expect(names(0)).not.toContain('fs_write')
    expect(names(0)).not.toContain('bash_run')
    expect(names(1)).toEqual(expect.arrayContaining(['fs_write', 'fs_edit', 'bash_run']))
  })

  it('writes only when armed with write', () => {
    expect(new RunAgentAction(session, { provider: 'fake' }).sideEffects).toBe('none')
    expect(new RunAgentAction(session, { provider: 'fake', write: true }).sideEffects).toBe('write')
  })

  it('an unknown sub-agent or a missing brief is an error the model can read', async () => {
    const tool = new RunAgentAction(session, { provider: 'fake', registry: reading([]) }).asTool(
      ctx(),
    )
    await expect(tool.handler({ agent: 'nadie', brief: 'x' })).rejects.toThrow(
      /Sub-agentes del repo/,
    )
    await expect(tool.handler({ agent: 'reader' })).rejects.toThrow(/Falta el `brief`/)
  })
})
