import { contextBridge, ipcRenderer } from 'electron'

// El preload de IA Flow.app.
//
// Corre antes que los scripts de la página, en el mundo aislado. Expone UNA
// cosa: el puente para que la web guarde su lista de servers en el config dir
// en vez del localStorage de la ventana.
//
// Antes también inyectaba el token del gateway, leyéndolo del `.env` del repo.
// Se fue con la unificación: la app ya no levanta ningún gateway, así que no
// tiene forma legítima de conocer su token — lo configura el operador en la
// pantalla, como el de cualquier server.

// ── La lista de servers ──────────────────────────────────────────────────
//
// Se expone por IPC y no se deja en el localStorage de la ventana porque es
// CONFIG, no estado de una pestaña: sobrevive a limpiar datos del sitio, se
// puede inspeccionar y editar con un editor de texto, y vive junto al resto de
// la config de ia-flow en vez de adentro del perfil de Chromium.
//
// `contextBridge` y no `nodeIntegration`: la página sigue sin acceso a Node.
// Lo único que puede hacer es pedir estas dos operaciones, sobre un path que
// elige el main process — no uno que ella mande.

contextBridge.exposeInMainWorld('iaFlowDesktop', {
  loadServers: () => ipcRenderer.invoke('servers:load'),
  saveServers: (servers: unknown) => ipcRenderer.invoke('servers:save', servers),
})
