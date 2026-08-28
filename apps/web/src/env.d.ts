/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Token para `x-ia-flow-token` cuando el server corre con `api: full`. */
  readonly VITE_IA_FLOW_API_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
