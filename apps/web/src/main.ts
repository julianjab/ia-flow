import { restoreSelectedServer } from '@/features/servers/selection'
import axios from 'axios'
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './styles/theme.css'

// Token de la API, si el server al que apuntamos lo exige.
//
// El flavor `runner` con `settings.api: full` protege las 24 rutas con
// IA_FLOW_API_TOKEN (apps/server/src/routes/api-auth.ts) — sin el header, todo
// responde 401. Es el caso del deploy de Kubernetes, donde el Service deja la
// API alcanzable desde cualquier pod del cluster.
//
// Va como default global de axios y no en un cliente propio porque cada
// feature importa `axios` directo; los defaults son compartidos, asi que esto
// cubre todas las llamadas sin tocar 20 archivos.
//
// Vacio contra un server local sin guard: el header simplemente no se manda.
//
// ⚠️ Vite hornea las VITE_* en el bundle. Este SPA se corre en la maquina del
// dev (`bun run dev`), no se despliega, asi que el token vive en tu .env local
// — pero si algun dia se publica un build, esto lo expone.
const apiToken = import.meta.env.VITE_IA_FLOW_API_TOKEN
if (apiToken) axios.defaults.headers.common['x-ia-flow-token'] = apiToken

// Antes de montar: sin esto el primer fetch de cada store saldría al server
// proxeado y recién después cambiaría de destino.
restoreSelectedServer()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
