import type { MountedRunner } from '../boot.js'

/** El prefijo de los eventos crudos de GitHub (`github.<evento>`) y el de los de Slack. */
export const RAW_PREFIX = 'github.'
export const SLACK_PREFIX = 'slack.'

/**
 * Los tipos de evento crudos que alguna pipeline escucha. Sin un intake para el tipo no hay nada
 * que despachar. Se lee en cada evento: las pipelines se recargan en caliente como el resto de
 * `.config/`.
 */
export function listenedTypes(
  mounted: Pick<MountedRunner, 'pipelines'>,
  prefixes: readonly string[] = [RAW_PREFIX, SLACK_PREFIX],
): Set<string> {
  return new Set(
    mounted
      .pipelines()
      .flatMap((pipeline) => pipeline.on)
      .filter((type) => prefixes.some((prefix) => type.startsWith(prefix))),
  )
}
