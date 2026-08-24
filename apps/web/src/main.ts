import { restoreSelectedServer } from '@/features/servers/selection'
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './styles/theme.css'

// Antes de montar: sin esto el primer fetch de cada store saldría al server
// proxeado y recién después cambiaría de destino.
restoreSelectedServer()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
