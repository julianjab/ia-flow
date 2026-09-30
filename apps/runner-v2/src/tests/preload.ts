// Las copias de `.config` que arman los tests viven en el tmp del sistema, no en la app: sus
// actions resuelven `@ia-flow/*` y `zod` por los módulos virtuales, igual que en el bundle.
import { registerVirtualModules } from '../bundle/register.js'

registerVirtualModules()
