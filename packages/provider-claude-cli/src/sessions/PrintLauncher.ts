import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import {
  type CliSession,
  cliEnv,
  type Launcher,
  type LaunchSpec,
  type SessionExit,
} from './CliSession.js'

const MAX_OUTPUT = 256 * 1024

/** `claude -p`: el turno corre headless como un proceso hijo; el prompt entra por stdin. */
export class PrintLauncher implements Launcher {
  async launch(spec: LaunchSpec): Promise<CliSession> {
    const prompt = await readFile(spec.promptFile, 'utf-8')
    const child = spawn(spec.bin, ['-p', '--output-format', 'json', ...spec.argv], {
      cwd: spec.cwd,
      env: cliEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    const collect = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString('utf-8')
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const exited = new Promise<SessionExit>((resolve) => {
      child.once('error', (error) => resolve({ code: -1, output: error.message }))
      child.once('close', (code) => resolve({ code, output }))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
    return {
      exited,
      describe: `pid ${child.pid ?? '?'}`,
      close: async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
        await exited
      },
    }
  }
}
