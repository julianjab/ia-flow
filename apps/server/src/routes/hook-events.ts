import { recordHookToolResult, recordHookTranscript } from '@ia-flow/agent-engine'
import { HookEventSchema } from '@ia-flow/shared'
import { Hono } from 'hono'
import { createLogger } from '../logger.js'

// Endpoint that consumes Claude Code hooks forwarded by `hook-tool-use.ts`
// running under `iterm-claude` / `tmux-claude`. Each POST is translated into
// one or more entries in `daemon.log`. Writing via `createLogger()` also
// triggers the WS broadcast in `logger.ts`, so the web UI sees events live.
//
// Supported event variants (field `event` in payload):
//   absent / 'tool.call' → PostToolUse legacy path: emits tool.call + tool.result
//   'tool.pre'           → PreToolUse: emits tool.pre
//   'subagent.start'     → PreToolUse where tool_name=Task: emits subagent.start
//   'agent.prompt'       → UserPromptSubmit: emits agent.prompt
//   'agent.stop'         → Stop: emits agent.stop
//   'subagent.stop'      → SubagentStop: emits subagent.stop
//   'agent.session_start'→ SessionStart: emits agent.session_start
//
// Why an endpoint and not direct file writes: parallel hook invocations
// (Claude Code runs tools in parallel) writing to the same NDJSON corrupt
// lines; delegating to the server serialises via Bun's event loop + pino.
export function createHookEventsRouter() {
  const app = new Hono()
  const log = createLogger('hook-tool-use')

  app.post('/', async (c) => {
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const parsed = HookEventSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json({ error: 'Invalid payload', issues: parsed.error.issues }, 400)
    }

    const {
      runId,
      event,
      toolName,
      toolUseId,
      parentToolUseId,
      subagentType,
      description,
      input,
      result,
      prompt,
      stopReason,
      sessionId,
      source,
      isError,
      transcriptPath,
    } = parsed.data

    if (!event || event === 'tool.call') {
      // PostToolUse legacy path — emits the same tool.call + tool.result pair
      // that anthropic/provider.ts emits, so groupRelatedLogs in the UI can
      // pair them by toolUseId.
      log.info(
        { event: 'tool.call', runId, tool: toolName, toolUseId, parentToolUseId, input },
        'Tool call',
      )
      if (result !== undefined) {
        log.info(
          {
            event: 'tool.result',
            runId,
            tool: toolName,
            toolUseId,
            parentToolUseId,
            result,
            isError,
          },
          'Tool result',
        )
      }
      // Terminal providers run the model inside a Claude Code session, so
      // this hook is the only place the engine ever learns a tool ran. Tally
      // it so the run's execution log gets tool_calls/tool_errors like a
      // sync run does — see packages/agent-engine/src/run-telemetry.ts.
      recordHookToolResult(runId, isError, { toolName, transcriptPath })
    } else if (event === 'tool.pre') {
      // `debug`, no `info`: es el mismo tool_use que llega como `tool.call`
      // un instante después — en `info` triplicaba la traza de cada tool sin
      // que nadie lo consumiera (la UI aparea call/result por toolUseId). En
      // `debug` sigue sirviendo para lo único que `tool.call` no puede
      // mostrar: una tool que arrancó y nunca volvió.
      log.debug(
        { event: 'tool.pre', runId, tool: toolName, toolUseId, parentToolUseId, input },
        'Tool pre',
      )
    } else if (event === 'subagent.start') {
      log.info(
        {
          event: 'subagent.start',
          runId,
          toolUseId,
          parentToolUseId,
          subagentType,
          description,
          prompt,
        },
        'Subagent start',
      )
    } else if (event === 'agent.prompt') {
      log.info({ event: 'agent.prompt', runId, prompt }, 'User prompt')
    } else if (event === 'agent.stop' || event === 'subagent.stop') {
      log.info({ event, runId, stopReason }, 'Agent stop')
      if (transcriptPath) recordHookTranscript(runId, transcriptPath)
    } else if (event === 'agent.session_start') {
      log.info({ event: 'agent.session_start', runId, sessionId, source }, 'Session start')
      if (transcriptPath) recordHookTranscript(runId, transcriptPath)
    }

    return c.json({ ok: true })
  })

  return app
}
