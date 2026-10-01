import { describe, expect, it } from 'vitest'
import { acceptTrustDialog, isTrustDialog } from '../sessions/trustDialog.js'

/** Lo que mostraba una sesión colgada (Claude Code 2.x) en el worktree de una task. */
const DIALOG = `Accessing workspace:

/Users/x/.local/state/ia-flow/runner/workspaces/worktrees/lh-seller-v2-frontend/.worktrees/task-4218

Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.

Claude Code'll be able to read, edit, and execute files here.

Security guide

  No, exit
❯ Yes, I trust this folder

Enter to confirm · Esc to cancel`

/** La versión anterior del diálogo. */
const OLD_DIALOG = `Do you trust the files in this folder?

/Users/x/repo

❯ 1. Yes, proceed
  2. No, exit`

describe('the trust dialog', () => {
  it('is recognised in both versions, only with "Yes" selected', () => {
    expect(isTrustDialog(DIALOG)).toBe(true)
    expect(isTrustDialog(OLD_DIALOG)).toBe(true)
    expect(isTrustDialog(DIALOG.replace('  No, exit\n❯ Yes', '❯ No, exit\n  Yes'))).toBe(false)
    // La sesión ya trabajando, aunque hable de confiar en una carpeta, no es el diálogo.
    expect(isTrustDialog('> revisá si confiás en this folder\n⏺ Leyendo src/…')).toBe(false)
  })

  const watch = (screens: string[]) => {
    let i = 0
    const sent: string[] = []
    return {
      sent,
      watch: {
        capture: async () => screens[Math.min(i++, screens.length - 1)] as string,
        confirm: async () => {
          sent.push('Enter')
        },
        pollMs: 10,
        timeoutMs: 100,
        sleep: async () => {},
      },
    }
  }

  it('is accepted once when it shows up, even a moment after launching', async () => {
    const { sent, watch: w } = watch(['', '', DIALOG, DIALOG])
    expect(await acceptTrustDialog(w)).toBe(true)
    expect(sent).toEqual(['Enter'])
  })

  it('a session that opens straight into work is left alone until the watch ends', async () => {
    const { sent, watch: w } = watch(['⏺ Leyendo el issue…'])
    expect(await acceptTrustDialog(w)).toBe(false)
    expect(sent).toEqual([])
  })

  it('stops when the session is gone or closed', async () => {
    const gone = await acceptTrustDialog({
      capture: async () => {
        throw new Error("can't find session")
      },
      confirm: async () => {
        throw new Error('no debería')
      },
      sleep: async () => {},
    })
    expect(gone).toBe(false)
    const closed = new AbortController()
    closed.abort()
    const { sent, watch: w } = watch([DIALOG])
    expect(await acceptTrustDialog({ ...w, signal: closed.signal })).toBe(false)
    expect(sent).toEqual([])
  })
})
