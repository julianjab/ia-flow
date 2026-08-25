// Entry de la consola del gateway — el segundo bundle de esta app.
//
// No monta la SPA de ia-flow: es otra pantalla, contra otro proceso y con otra
// credencial. Comparte el tema y los componentes de `ui/`, que es todo lo que
// hay que compartir. Sin router (una sola vista) y sin Pinia (el estado vive
// en la vista, y sobrevive tanto como la pestaña).

import { createApp } from 'vue'
import GatewayConsole from './features/gateway/GatewayConsole.vue'
import './styles/theme.css'

createApp(GatewayConsole).mount('#app')
