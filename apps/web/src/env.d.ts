/// <reference types="vite/client" />

type ImportMetaEnv = {
  /** mac-pulse, de donde sale el portapapeles de la Mac (features/mac-clipboard). */
  readonly VITE_MAC_PULSE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<{}, {}, any>
  export default component
}
