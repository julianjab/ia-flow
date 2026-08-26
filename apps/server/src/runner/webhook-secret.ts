// El secreto del webhook, resuelto o generado — lo que `entrypoint.sh` hacía
// con `head -c32 /dev/urandom | base64 | tr -dc ...`.
//
// Mudarlo a TS no es sólo estética: en el script el secreto se generaba en el
// arranque del contenedor y se exportaba al proceso hijo, así que la única
// forma de testear la rama "ya existía, reusalo" era levantar un contenedor.
// Acá es una función pura salvo por dos llamadas de fs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { CONFIG_DIR } from '../infrastructure/db/index.js'
import { createLogger } from '../logger.js'

const log = createLogger('webhook-secret')

/**
 * Orden: el env (lo que el operador puso a mano) → el archivo persistido → uno
 * nuevo.
 *
 * **Se persiste a propósito.** Los endpoints de webhook fallan cerrado (503)
 * sin secreto, así que hay que tener uno; pero si se regenerara en cada boot,
 * el que quedó configurado en GitHub dejaría de matchear y las deliveries
 * empezarían a rebotar con 401 después de un simple `restart` — un fallo que
 * desde afuera se ve como "el runner dejó de reaccionar", sin ningún error en
 * sus logs.
 *
 * Deja el valor en `process.env` porque el router lo lee por request
 * (`routes/webhooks.ts:24`), igual que el resto de la config del daemon.
 */
export function resolveWebhookSecret(filePath = `${CONFIG_DIR}/webhook-secret`): string {
  const fromEnv = process.env.IA_FLOW_WEBHOOK_SECRET?.trim()
  if (fromEnv) return fromEnv

  if (existsSync(filePath)) {
    const saved = readFileSync(filePath, 'utf-8').trim()
    if (saved) {
      process.env.IA_FLOW_WEBHOOK_SECRET = saved
      return saved
    }
  }

  const generated = crypto.randomUUID().replaceAll('-', '')
  mkdirSync(dirname(filePath), { recursive: true })
  // 0600: el volumen puede estar montado en un host compartido, y este string
  // es lo único que separa a un `POST /api/webhooks/github` legítimo de uno
  // que dispara agentes contra tu board.
  writeFileSync(filePath, `${generated}\n`, { mode: 0o600 })
  process.env.IA_FLOW_WEBHOOK_SECRET = generated
  log.warn({ filePath }, 'webhook secret generado y persistido — configuralo en GitHub')
  return generated
}
