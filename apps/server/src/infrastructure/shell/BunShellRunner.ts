// Real ShellRunner used by WorkspaceManager in production. Delegates to
// `Bun.spawn` and never throws for non-zero exits — the caller inspects
// `exitCode` (matches the WorkspaceManager helpers, which turn shell
// failures into typed errors).
//
// Tests inject a stub `ShellRunner` directly (see WorkspaceManager.test.ts),
// so this class only ever runs when wired from `composition/container.ts`.

import type { ShellResult, ShellRunner } from '../../application/WorkspaceManager.js'

export class BunShellRunner implements ShellRunner {
  async run(args: string[], cwd: string): Promise<ShellResult> {
    if (args.length === 0) {
      throw new Error('BunShellRunner.run called with empty args')
    }
    const proc = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited
    return { stdout, stderr, exitCode }
  }
}
