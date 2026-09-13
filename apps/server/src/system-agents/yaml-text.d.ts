// `base-agents.yaml` se importa como texto (`with { type: 'text' }`) y no se
// lee con `readFileSync` a propósito: el flavor `runner` corre desde un
// bundle de un solo archivo (`bun build`, ver Dockerfile.runner) sin
// `node_modules` NI el resto del repo al lado — un `readFileSync` relativo a
// `import.meta.url` no encontraría el YAML ahí. El import de texto hace que
// Bun lo embeba en el bundle en tiempo de build, así que funciona igual en
// los dos flavors sin acceso a filesystem en runtime.
declare module '*.yaml' {
  const content: string
  export default content
}
