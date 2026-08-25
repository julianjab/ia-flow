// La única pantalla del gateway: qué expone, cuánto corre, contra qué servers
// está registrado y con qué criterio acepta trabajo.
//
// Se sirve como un string, sin build ni assets: el gateway es un proceso
// suelto que se levanta en cualquier máquina, y meterle un bundler para una
// página de dos tarjetas sería más infraestructura que producto.
//
// La página en sí NO lleva datos: pide el bearer token al usuario, lo guarda
// en su localStorage y consulta `/v1/provider` y `/v1/capacity` como lo haría
// el daemon. Por eso puede servirse sin auth sin exponer nada — sin token no
// muestra más que un formulario.
//
// Los colores salen de apps/web/src/styles/theme.css (Design System v4). Se
// copian a mano a propósito: importar el CSS de la web ataría este proceso al
// build de la SPA, que es justo lo que no queremos acá.

import { LEVEL_NAMES } from './log-tail.js'

export const GATEWAY_UI_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ai-provider-gateway</title>
<link rel="icon" href="data:," />
<style>
  :root {
    --bg: #0f1113; --panel: #17191c; --border: #2c2f34; --border-hi: #3d4148;
    --fg: #ece9e2; --fg-mute: #b5b1a7; --fg-dim: #85817a;
    --green: #7fb8ac; --red: #e0665c; --yellow: #d9a441; --cyan: #6fbfc4;
    --accent: var(--green);
    --font-body: "IBM Plex Sans", -apple-system, "Segoe UI", sans-serif;
    --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 3rem 1.5rem; background: var(--bg); color: var(--fg);
    font-family: var(--font-body); font-size: 14px; line-height: 1.5;
  }
  .wrap { max-width: 46rem; margin: 0 auto; }
  h1 { margin: 0; font-size: 1.25rem; font-weight: 600; letter-spacing: 0.02em; }
  .sub { margin: 0.3rem 0 2rem; color: var(--fg-dim); font-size: 0.85rem; }
  .mono { font-family: var(--font-mono); }

  .card {
    border: 1px solid var(--border); background: var(--panel);
    padding: 0.9rem 1rem; margin-bottom: 0.8rem; border-radius: 2px;
  }
  .card__hd {
    display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.7rem;
    font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--fg-dim);
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fg-dim); flex: none; }
  .dot--up { background: var(--accent); }
  .dot--down { background: var(--red); }
  .dot--warn { background: var(--yellow); }

  .grid { display: grid; grid-template-columns: max-content 1fr; gap: 0.3rem 1rem; align-items: baseline; }
  .list { list-style: none; margin: 0; padding: 0; }
  .item {
    display: flex; align-items: center; gap: 0.5rem; padding: 0.35rem 0;
    border-bottom: 1px solid var(--border);
  }
  .item:last-child { border-bottom: 0; }
  .item .grow { flex: 1; font-family: var(--font-mono); font-size: 0.85rem; word-break: break-all; }
  .x { border: 0; background: none; color: var(--fg-dim); cursor: pointer; font-size: 1rem; padding: 0 0.2rem; }
  .x:hover { color: var(--red); }
  select {
    padding: 0.3rem 0.4rem; border: 1px solid var(--border-hi); background: var(--bg);
    color: inherit; font: inherit; font-size: 0.82rem;
  }
  .rule-row { display: flex; gap: 0.4rem; flex-wrap: wrap; align-items: center; margin-top: 0.6rem; }
  .rule-row input { flex: 1; min-width: 9rem; }
  .num { width: 6rem; }
  .k { color: var(--fg-dim); font-size: 0.8rem; }
  .v { font-family: var(--font-mono); word-break: break-word; }
  .v--accent { color: var(--accent); }
  .v--danger { color: var(--red); }
  .v--big { font-size: 1.5rem; }

  input {
    width: 100%; padding: 0.4rem 0.55rem; border: 1px solid var(--border-hi);
    background: transparent; color: inherit; font-family: var(--font-mono); font-size: 0.85rem;
  }
  button {
    padding: 0.35rem 0.8rem; border: 1px solid var(--border-hi); background: transparent;
    color: inherit; font: inherit; font-size: 0.85rem; cursor: pointer;
  }
  button:hover { border-color: var(--accent); color: var(--accent); }
  .row { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.6rem; }
  .msg { color: var(--red); font-size: 0.8rem; min-height: 1.2em; }
  .hint { color: var(--fg-dim); font-size: 0.78rem; margin: 0.5rem 0 0; }
  [hidden] { display: none !important; }

  /* Logs — alto fijo y scroll propio: la card no puede crecer hasta empujar
     el resto de la pantalla fuera de la vista. */
  .log {
    height: 22rem; overflow: auto; margin: 0.6rem 0 0; padding: 0.5rem;
    background: var(--bg); border: 1px solid var(--border);
    font-family: var(--font-mono); font-size: 0.78rem; line-height: 1.45;
  }
  .log-line { display: flex; gap: 0.6rem; padding: 0.1rem 0; white-space: pre-wrap; word-break: break-word; }
  .log-line + .log-line { border-top: 1px solid rgba(255,255,255,0.03); }
  .log-t { color: var(--fg-dim); flex: none; }
  .log-l { flex: none; width: 3.2rem; text-transform: uppercase; font-size: 0.7rem; padding-top: 0.15rem; }
  .log-l--info { color: var(--cyan); }
  .log-l--warn { color: var(--yellow); }
  .log-l--error { color: var(--red); }
  .log-l--debug { color: var(--fg-dim); }
  .log-m { flex: 1; }
  .log-x { color: var(--fg-mute); }
  .log-search { display: flex; gap: 0.5rem; align-items: center; }
  .log-search input { flex: 1; }
  .log-foot { display: flex; gap: 0.8rem; align-items: center; flex-wrap: wrap; margin-top: 0.5rem; }
  .log-foot label { display: flex; gap: 0.3rem; align-items: center; color: var(--fg-dim); font-size: 0.78rem; }
  .log-foot input[type=checkbox] { width: auto; }
</style>
</head>
<body>
<div class="wrap">
  <h1>ai-provider-gateway</h1>
  <p class="sub">Lo que expone este proceso y cuánto está corriendo ahora.</p>

  <!-- Sin token no hay nada que mostrar: la página no trae datos horneados. -->
  <section id="auth" class="card" hidden>
    <div class="card__hd"><span class="dot"></span>token</div>
    <label class="k" for="token">API_AI_PROVIDER_TOKEN — el mismo del .env de este gateway</label>
    <div class="row">
      <input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="Bearer token" />
      <button id="save">entrar</button>
    </div>
    <p class="msg" id="auth-msg"></p>
    <p class="hint">Queda en el localStorage de este navegador. No se manda a ningún lado salvo a este gateway.</p>
  </section>

  <div id="panels" hidden>
    <section class="card">
      <div class="card__hd"><span class="dot" id="provider-dot"></span>provider</div>
      <div class="grid">
        <span class="k">nombre</span><span class="v v--accent" id="p-name">—</span>
        <span class="k">kind</span><span class="v" id="p-kind">—</span>
        <span class="k">qué hace</span><span class="v" id="p-desc">—</span>
      </div>
      <div class="row" id="p-switch" hidden>
        <label class="k" for="p-id">exponer</label>
        <select id="p-id"></select>
        <button id="p-save">cambiar</button>
        <span class="k" id="p-stamp"></span>
      </div>
      <p class="hint">
        Cambia sin reiniciar. Un run en curso termina con el que le tocó; el
        cambio aplica a los siguientes. Los servers donde estás registrado se
        vuelven a dar de alta, porque guardaron el nombre del provider viejo.
      </p>
      <p class="msg" id="p-msg"></p>
    </section>

    <section class="card">
      <div class="card__hd"><span class="dot" id="cap-dot"></span>capacidad</div>
      <div class="grid">
        <span class="k">corriendo</span>
        <span class="v v--big" id="c-running">—</span>
        <span class="k">tope</span><span class="v" id="c-max">—</span>
        <span class="k">admite</span><span class="v" id="c-accepting">—</span>
        <span class="k">motivo</span><span class="v" id="c-reason">—</span>
      </div>
      <p class="msg" id="panel-msg"></p>
    </section>

    <section class="card">
      <div class="card__hd"><span class="dot dot--up"></span>registrado en</div>
      <ul class="list" id="regs"></ul>
      <p class="hint" id="regs-empty" hidden>· no está registrado en ningún server</p>
      <div class="row">
        <input id="reg-url" placeholder="http://localhost:3011" spellcheck="false" />
        <button id="reg-add">registrar acá</button>
      </div>
      <p class="hint">
        Sólo la URL del server. Por dónde te alcanza a vos se descubre solo: si
        no llega por <code>localhost</code> —porque corre dentro de un
        container, donde eso significa el container mismo— se reintenta con
        <code>host.containers.internal</code>. La fila muestra cuál quedó.
      </p>
      <p class="hint">
        Se guarda: al reiniciar, el gateway vuelve a darse de alta en estos
        (y deja de mirar IA_FLOW_REGISTER_SERVER_URLS).
      </p>
      <p class="msg" id="reg-msg"></p>
    </section>

    <section class="card">
      <div class="card__hd"><span class="dot dot--up"></span>cuándo acepto trabajo</div>
      <div class="row">
        <label class="k" for="cap">tope de runs en paralelo</label>
        <input class="num" id="cap" type="number" min="0" step="1" />
        <span class="k">0 = sin tope</span>
      </div>

      <ul class="list" id="rules" style="margin-top:0.8rem"></ul>
      <p class="hint" id="rules-empty" hidden>· sin reglas — acepta cualquier tarea</p>

      <div class="rule-row">
        <select id="r-field">
          <option value="repo">repo</option>
          <option value="agentId">agentId</option>
          <option value="projectId">projectId</option>
          <option value="taskType">taskType</option>
          <option value="assignee">assignee</option>
        </select>
        <select id="r-op">
          <option value="equals">es</option>
          <option value="notEquals">no es</option>
          <option value="matches">matchea</option>
          <option value="notMatches">no matchea</option>
        </select>
        <input id="r-value" placeholder="la-haus/subscriptions  ·  * como comodín" spellcheck="false" />
        <button id="r-add">agregar</button>
      </div>

      <div class="row">
        <button id="save-admission">guardar</button>
        <span class="k" id="admission-stamp"></span>
      </div>
      <p class="hint">
        Todas las reglas tienen que cumplirse. Una regla sobre un campo que la
        tarea no trae no rechaza — el filtro de verdad corre al recibir el run.
      </p>
      <p class="msg" id="admission-msg"></p>
    </section>

    <section class="card">
      <div class="card__hd"><span class="dot" id="log-dot"></span>logs</div>
      <div class="log-search">
        <input id="log-q" placeholder="filtrar — error · warn · un taskId · dos palabras acotan" spellcheck="false" />
        <button id="log-clear" title="limpiar el filtro">×</button>
      </div>
      <div class="log" id="log-out"></div>
      <div class="log-foot">
        <label><input type="checkbox" id="log-follow" checked /> seguir</label>
        <label>últimas <input class="num" id="log-limit" type="number" min="1" step="50" value="200" /></label>
        <span class="k" id="log-file"></span>
      </div>
      <p class="hint" id="log-note" hidden></p>
      <p class="hint" id="log-off" hidden>
        Este gateway corre sin archivo de log (IA_FLOW_GATEWAY_LOG_FILE vacío,
        como en el Dockerfile). Los logs están en el stdout del proceso.
      </p>
      <p class="msg" id="log-msg"></p>
    </section>

    <div class="row">
      <button id="refresh">refrescar</button>
      <button id="forget">olvidar token</button>
      <span class="k" id="stamp"></span>
    </div>
  </div>
</div>

<script>
  const KEY = 'ia-flow:gateway:token'
  const $ = (id) => document.getElementById(id)
  let timer = null

  const get = () => { try { return localStorage.getItem(KEY) } catch { return null } }
  const set = (v) => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY) } catch {} }

  async function api(path, init) {
    const res = await fetch(path, {
      ...init,
      headers: { authorization: 'Bearer ' + get(), 'content-type': 'application/json' },
    })
    if (res.status === 401) throw new Error('token rechazado')
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || 'HTTP ' + res.status)
    }
    return res.json()
  }

  // Las reglas viven acá mientras las editás; recién van al gateway al guardar,
  // así podés armar varias sin que cada tecla cambie el criterio de admisión.
  let rules = []

  // Se pinta el ESTADO del alta, no sólo la URL: un alta fallida y una exitosa
  // se veían igual, y así la pantalla decía "registrado en X" mientras el
  // server no lo tenía.
  function renderRegs(registrations) {
    $('regs').innerHTML = ''
    $('regs-empty').hidden = registrations.length > 0
    for (const reg of registrations) {
      const li = document.createElement('li')
      li.className = 'item'

      const dot = document.createElement('span')
      dot.className = 'dot ' + (reg.ok ? 'dot--up' : 'dot--down')

      const span = document.createElement('span')
      span.className = 'grow'
      span.textContent = reg.serverUrl
      if (!reg.ok && reg.reason) {
        const why = document.createElement('div')
        why.className = 'k'
        why.style.color = 'var(--red)'
        why.textContent = reg.reason
        span.append(why)
      } else if (reg.ok && reg.publicUrl) {
        const how = document.createElement('div')
        how.className = 'k'
        how.textContent = 'me alcanza en ' + reg.publicUrl
        span.append(how)
      }

      const btn = document.createElement('button')
      btn.className = 'x'
      btn.title = 'desregistrarse de este server'
      btn.textContent = '×'
      btn.onclick = () => unregister(reg.serverUrl)

      li.append(dot, span, btn)
      $('regs').append(li)
    }
  }

  const OP_LABEL = { equals: 'es', notEquals: 'no es', matches: 'matchea', notMatches: 'no matchea' }

  function renderRules() {
    $('rules').innerHTML = ''
    $('rules-empty').hidden = rules.length > 0
    rules.forEach((rule, i) => {
      const li = document.createElement('li')
      li.className = 'item'
      const span = document.createElement('span')
      span.className = 'grow'
      span.textContent = rule.field + ' ' + (OP_LABEL[rule.op] || rule.op) + ' ' + rule.value
      const btn = document.createElement('button')
      btn.className = 'x'
      btn.textContent = '×'
      btn.onclick = () => { rules.splice(i, 1); renderRules() }
      li.append(span, btn)
      $('rules').append(li)
    })
  }

  // ── Logs ────────────────────────────────────────────────────────────────
  // El filtro NO se aplica acá: se manda al gateway, que lo corre contra el
  // archivo entero. Filtrar en el navegador sólo miraría las líneas que ya
  // bajaron — las últimas — que son justo las que uno no está buscando
  // cuando escribe "error".

  // Interpolado desde log-tail.ts: el filtro del server matchea por estos
  // mismos nombres, y dos copias que se desincronizan harían que la pantalla
  // muestre "warn" en una línea que buscar "warn" no encuentra.
  const LEVEL = ${JSON.stringify(LEVEL_NAMES)}

  function atBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  function renderLogs(tail) {
    const out = $('log-out')
    const stick = $('log-follow').checked
    out.innerHTML = ''

    if (!tail.file) {
      $('log-off').hidden = false
      $('log-file').textContent = ''
      $('log-dot').className = 'dot'
      return
    }
    $('log-off').hidden = true
    $('log-file').textContent = tail.file
    $('log-dot').className = 'dot dot--up'

    // Vacío con filtro y vacío sin filtro son cosas distintas: uno es "no hay
    // nada", el otro es "no encontré" — y el segundo se arregla borrando el
    // filtro, así que hay que poder distinguirlos.
    if (!tail.lines.length) {
      const empty = document.createElement('div')
      empty.className = 'k'
      empty.textContent = $('log-q').value.trim()
        ? 'Ninguna línea coincide con «' + $('log-q').value.trim() + '».'
        : 'El archivo todavía no tiene líneas.'
      out.append(empty)
    }

    for (const line of tail.lines) {
      const row = document.createElement('div')
      row.className = 'log-line'

      const t = document.createElement('span')
      t.className = 'log-t'
      t.textContent = line.time ? new Date(line.time).toLocaleTimeString() : '--:--:--'

      const lvl = document.createElement('span')
      const name = LEVEL[line.level] || ''
      lvl.className = 'log-l log-l--' + (name === 'fatal' ? 'error' : name || 'debug')
      lvl.textContent = name

      const m = document.createElement('span')
      m.className = 'log-m'
      m.textContent = line.msg || line.raw

      if (line.extras) {
        const x = document.createElement('span')
        x.className = 'log-x'
        // Los extras son la mitad del valor de un log de pino (taskId, repo,
        // el reason de un rechazo): se muestran siempre, no detrás de un clic.
        x.textContent = '  ' + JSON.stringify(line.extras)
        m.append(x)
      }

      row.append(t, lvl, m)
      out.append(row)
    }

    // Un log que salta al fondo mientras leés arriba es inusable; por eso el
    // autoscroll está atado al checkbox, y el checkbox se destilda solo
    // cuando scrolleás hacia arriba (ver abajo).
    if (stick) out.scrollTop = out.scrollHeight

    $('log-note').hidden = !tail.truncated
    if (tail.truncated) {
      $('log-note').textContent =
        'El filtro miró los últimos 4 MB del archivo. Hay historia más vieja que no entra: ' +
        'grep sobre ' + tail.file + ' para eso.'
    }
  }

  // Dos cosas piden el tail: el sondeo de 5s y cada tecla del filtro. Sin un
  // número de orden, una respuesta lenta del filtro viejo puede llegar
  // DESPUÉS de la del nuevo y repintar lo anterior — se ve como un filtro que
  // no toma. Sólo pinta la última pedida.
  let logSeq = 0

  async function loadLogs() {
    const mine = ++logSeq
    // Se pide aparte del resto del panel: que el tail falle (archivo borrado,
    // permisos) no puede llevarse puesta la card de capacidad.
    try {
      const limit = Number.parseInt($('log-limit').value, 10)
      const params =
        '?limit=' + (Number.isFinite(limit) && limit > 0 ? limit : 200) +
        '&q=' + encodeURIComponent($('log-q').value.trim())
      const tail = await api('/v1/logs' + params)
      if (mine !== logSeq) return
      renderLogs(tail)
      $('log-msg').textContent = ''
    } catch (err) {
      if (mine !== logSeq) return
      $('log-msg').textContent = 'No pude leer los logs: ' + err.message
    }
  }

  async function unregister(url) {
    $('reg-msg').textContent = ''
    try {
      const { registrations } = await api('/v1/registrations?serverUrl=' + encodeURIComponent(url), { method: 'DELETE' })
      renderRegs(registrations ?? [])
    } catch (err) { $('reg-msg').textContent = err.message }
  }

  function showAuth(msg) {
    if (timer) { clearInterval(timer); timer = null }
    $('auth').hidden = false
    $('panels').hidden = true
    $('auth-msg').textContent = msg || ''
  }

  async function load() {
    try {
      const [provider, capacity, admission, regs] = await Promise.all([
        api('/v1/provider'),
        api('/v1/capacity'),
        api('/v1/admission'),
        api('/v1/registrations'),
      ])

      $('p-name').textContent = provider.name || '—'
      $('p-kind').textContent = provider.kind || '—'
      $('p-desc').textContent = provider.description || '—'
      $('provider-dot').className = 'dot dot--up'

      // El selector sólo aparece si esta instancia sabe construir más de uno.
      const available = provider.available || []
      $('p-switch').hidden = available.length < 2
      if (available.length >= 2 && document.activeElement !== $('p-id')) {
        $('p-id').innerHTML = ''
        for (const id of available) {
          const opt = document.createElement('option')
          opt.value = id
          opt.textContent = id
          opt.selected = id === provider.id
          $('p-id').append(opt)
        }
      }

      $('c-running').textContent = capacity.running
      // null = sin tope. Mismo criterio que los caps del engine: 0/ausente
      // no significa "frenar todo", significa "sin límite".
      $('c-max').textContent = capacity.maxConcurrentRuns === null ? 'sin límite' : capacity.maxConcurrentRuns
      $('c-accepting').textContent = capacity.accepting ? 'sí' : 'no'
      $('c-accepting').className = 'v ' + (capacity.accepting ? 'v--accent' : 'v--danger')
      $('c-reason').textContent = capacity.reason || '—'
      $('cap-dot').className = 'dot ' + (capacity.accepting ? 'dot--up' : 'dot--warn')

      renderRegs(regs.registrations ?? [])
      // No pisamos lo que estés editando: el sondeo cada 5s no puede borrarte
      // una regla a medio escribir.
      if (document.activeElement !== $('cap')) {
        $('cap').value = admission.maxConcurrentRuns ?? 0
      }
      if (!dirty) { rules = admission.rules.slice(); renderRules() }

      // El tail se refresca con el resto del sondeo, pero sólo mientras
      // "seguir" esté tildado: si estás leyendo algo arriba, recargar cada 5s
      // te lo arranca de las manos.
      if ($('log-follow').checked) loadLogs()

      $('stamp').textContent = 'actualizado ' + new Date().toLocaleTimeString()
      $('panel-msg').textContent = ''
      $('auth').hidden = true
      $('panels').hidden = false
    } catch (err) {
      if (String(err.message).includes('token')) { set(null); showAuth('Ese token no sirve.'); return }
      $('panel-msg').textContent = 'No pude leer el gateway: ' + err.message
    }
  }

  function start() {
    if (!get()) { showAuth(); return }
    load()
    // Sondeo corto: lo único que se mueve es el contador de runs.
    if (!timer) timer = setInterval(load, 5000)
  }

  let dirty = false

  $('p-save').onclick = async () => {
    $('p-msg').textContent = ''
    try {
      await api('/v1/provider', { method: 'PUT', body: JSON.stringify({ id: $('p-id').value }) })
      $('p-stamp').textContent = 'cambiado ' + new Date().toLocaleTimeString()
      load()
    } catch (err) { $('p-msg').textContent = err.message }
  }

  $('r-add').onclick = () => {
    const value = $('r-value').value.trim()
    if (!value) return
    rules.push({ field: $('r-field').value, op: $('r-op').value, value })
    $('r-value').value = ''
    dirty = true
    renderRules()
  }
  $('r-value').onkeydown = (e) => { if (e.key === 'Enter') $('r-add').click() }
  $('cap').oninput = () => { dirty = true }

  $('save-admission').onclick = async () => {
    $('admission-msg').textContent = ''
    try {
      const cap = Number.parseInt($('cap').value, 10)
      await api('/v1/admission', {
        method: 'PUT',
        body: JSON.stringify({ maxConcurrentRuns: Number.isFinite(cap) ? cap : 0, rules }),
      })
      dirty = false
      $('admission-stamp').textContent = 'guardado ' + new Date().toLocaleTimeString()
      load()
    } catch (err) { $('admission-msg').textContent = err.message }
  }

  $('reg-add').onclick = async () => {
    const url = $('reg-url').value.trim()
    if (!url) return
    $('reg-msg').textContent = ''
    try {
      const { registration } = await api('/v1/registrations', {
        method: 'POST',
        body: JSON.stringify({ serverUrl: url }),
      })
      // El alta falla seguido (server abajo, publicUrl que no alcanza): el
      // motivo se muestra tal cual lo devolvió el server, y el campo NO se
      // limpia para poder corregir sin re-tipear.
      if (registration && !registration.ok) {
        $('reg-msg').textContent = registration.reason || 'no se pudo registrar'
      } else {
        $('reg-url').value = ''
      }
      load()
    } catch (err) { $('reg-msg').textContent = err.message }
  }
  $('reg-url').onkeydown = (e) => { if (e.key === 'Enter') $('reg-add').click() }

  // Debounce: cada tecla dispararía una lectura del archivo entero.
  let logTimer = null
  $('log-q').oninput = () => {
    clearTimeout(logTimer)
    logTimer = setTimeout(loadLogs, 250)
  }
  $('log-limit').onchange = loadLogs
  $('log-clear').onclick = () => { $('log-q').value = ''; loadLogs() }
  // Scrollear hacia arriba es la forma natural de decir "pará, estoy
  // leyendo": destilda el seguimiento en vez de pelearse con el usuario.
  $('log-out').onscroll = () => {
    if (!atBottom($('log-out'))) $('log-follow').checked = false
  }
  $('log-follow').onchange = () => { if ($('log-follow').checked) loadLogs() }

  $('save').onclick = () => { const v = $('token').value.trim(); if (!v) return; set(v); $('token').value = ''; start() }
  $('token').onkeydown = (e) => { if (e.key === 'Enter') $('save').click() }
  $('refresh').onclick = load
  $('forget').onclick = () => { set(null); showAuth() }
  start()
</script>
</body>
</html>`
