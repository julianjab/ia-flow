import { restoreSelectedServer } from '@/features/servers/selection'
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './styles/theme.css'

// Antes de montar: restaura contra qué server mirar Y con qué token. Sin esto
// el primer fetch de cada store saldría al server proxeado, y sin credencial.
//
// El token ya NO sale de `VITE_IA_FLOW_API_TOKEN`. Esa variable la horneaba
// Vite en el bundle —uno solo para todos los servers, y congelado adentro del
// .dmg publicado— y se aplicaba como `axios.defaults.headers.common`, que se
// mergea en TODA request: el token del server salía también hacia cada host
// que la pantalla de servers sondea. Ahora vive por server y lo aplica un
// interceptor acotado por origen (features/servers/selection.ts).
restoreSelectedServer()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
