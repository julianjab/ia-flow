import { z } from 'zod'

/**
 * Un provider remoto, como lo declara el runner (`runner.yaml`, `providers.<id>` con
 * `type: remote`). Estricto: una clave de otro provider es un error al montar. El `providerConfig`
 * de cada agente NO se valida acá: viaja tal cual y lo valida el provider del host.
 */
export const RemoteProviderConfig = z.strictObject({
  /** La base del host (`http://gpu-box:3002`), sin `/v1`. */
  url: z.url(),
  /** El bearer que el host espera. */
  token: z.string().min(1),
  /** El id del provider EN el host. Default: el mismo id con el que lo registra el runner. */
  provider: z.string().min(1).optional(),
  /** Cuántos agentes a la vez sobre este provider, de este lado (el host tiene el suyo). */
  maxConcurrent: z.number().int().positive().optional(),
  /** Cuánto silencio seguido del host se tolera antes de dar la corrida por perdida. Alcanza para
   *  un reinicio o un blip de red sin colgar el lugar para siempre. Default: 120; `0`, sin límite. */
  maxSilenceSeconds: z.number().int().min(0).optional(),
  /** Tope de una corrida entera. Default: sin tope — el provider del host ya tiene el suyo (ej.
   *  `timeoutMinutes` de claude-cli) y un segundo reloj sólo cortaría antes. */
  runTimeoutMinutes: z.number().int().positive().optional(),
})
export type RemoteProviderConfig = z.infer<typeof RemoteProviderConfig>

/** Tira con el detalle si `raw` no es una config válida. */
export function parseRemoteProviderConfig(raw: unknown): RemoteProviderConfig {
  const parsed = RemoteProviderConfig.safeParse(raw ?? {})
  if (!parsed.success) {
    throw new Error(`config de provider remoto inválida\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}
