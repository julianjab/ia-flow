// La única pantalla del gateway: qué provider expone y cuánto está corriendo.
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
      <div class="row">
        <button id="refresh">refrescar</button>
        <button id="forget">olvidar token</button>
        <span class="k" id="stamp"></span>
      </div>
      <p class="msg" id="panel-msg"></p>
    </section>
  </div>
</div>

<script>
  const KEY = 'ia-flow:gateway:token'
  const $ = (id) => document.getElementById(id)
  let timer = null

  const get = () => { try { return localStorage.getItem(KEY) } catch { return null } }
  const set = (v) => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY) } catch {} }

  async function api(path) {
    const res = await fetch(path, { headers: { authorization: 'Bearer ' + get() } })
    if (res.status === 401) throw new Error('token rechazado')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return res.json()
  }

  function showAuth(msg) {
    if (timer) { clearInterval(timer); timer = null }
    $('auth').hidden = false
    $('panels').hidden = true
    $('auth-msg').textContent = msg || ''
  }

  async function load() {
    try {
      const [provider, capacity] = await Promise.all([api('/v1/provider'), api('/v1/capacity')])

      $('p-name').textContent = provider.name || '—'
      $('p-kind').textContent = provider.kind || '—'
      $('p-desc').textContent = provider.description || '—'
      $('provider-dot').className = 'dot dot--up'

      $('c-running').textContent = capacity.running
      // null = sin tope. Mismo criterio que los caps del engine: 0/ausente
      // no significa "frenar todo", significa "sin límite".
      $('c-max').textContent = capacity.maxConcurrentRuns === null ? 'sin límite' : capacity.maxConcurrentRuns
      $('c-accepting').textContent = capacity.accepting ? 'sí' : 'no'
      $('c-accepting').className = 'v ' + (capacity.accepting ? 'v--accent' : 'v--danger')
      $('c-reason').textContent = capacity.reason || '—'
      $('cap-dot').className = 'dot ' + (capacity.accepting ? 'dot--up' : 'dot--warn')

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

  $('save').onclick = () => { const v = $('token').value.trim(); if (!v) return; set(v); $('token').value = ''; start() }
  $('token').onkeydown = (e) => { if (e.key === 'Enter') $('save').click() }
  $('refresh').onclick = load
  $('forget').onclick = () => { set(null); showAuth() }
  start()
</script>
</body>
</html>`
