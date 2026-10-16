<script setup lang="ts">
import type { ConfigSummary } from '@ia-flow/shared';

// Con qué corren las pipelines: cada agente con sus providers, su modelo, sus MCP
// (y si quedaron montados), sus tools, a dónde lleva cada una de sus salidas y su
// prompt plegado; los providers de runner.yaml y los MCP. Nada de esto trae un
// secreto: el runner sólo manda tipo, modo, tope, ids y el host de un MCP.

defineProps<{ config: ConfigSummary }>();

type AgentEntry = ConfigSummary['agents'][number];

/** Los modelos del agente, sin repetir: lo que se lee en la fila plegada. */
const models = (a: AgentEntry) => [...new Set(Object.values(a.models))].join(' · ');
const mcpDown = (a: AgentEntry) => a.mcp_servers.filter((m) => !m.mounted).length;
/** `1.2k car.`: cuánto mide un prompt (el runner puede mandarlo recortado). */
const chars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k car.` : `${n} car.`);
const clipped = (shown: string, total: number) => shown.length < total;
</script>

<template>
  <section class="cc" aria-label="Agentes">
    <h2 class="cc__hd">Agentes <span class="cc__n mono">{{ config.agents.length }}</span></h2>
    <ul class="cc__list">
      <li v-for="a in config.agents" :key="a.id">
        <details class="cc__item">
          <summary class="cc__row">
            <span class="cc__chev" aria-hidden="true">▸</span>
            <span class="mono cc__id">{{ a.id }}</span>
            <span class="cc__dim mono">{{ a.providers.join(' → ') }}</span>
            <span v-if="models(a)" class="cc__dim mono" data-test="models">{{ models(a) }}</span>
            <span v-if="mcpDown(a)" class="cc__warn">{{ mcpDown(a) }} MCP sin montar</span>
          </summary>
          <dl v-if="a.mcp_servers.length || a.actions.length" class="cc__facts">
            <template v-if="a.mcp_servers.length">
              <dt class="uc-label">MCP</dt>
              <dd>
                <span v-for="m in a.mcp_servers" :key="m.id" class="mono" :class="{ cc__warn: !m.mounted }" :data-test="`mcp-${m.id}`">
                  {{ m.id }}<template v-if="!m.mounted"> (sin montar)</template>
                </span>
              </dd>
            </template>
            <template v-if="a.actions.length">
              <dt class="uc-label">Tools</dt>
              <dd class="mono">{{ a.actions.join(' · ') }}</dd>
            </template>
          </dl>
          <ul class="cc__routes">
            <li v-for="(to, exit) in a.routes" :key="exit">
              <span class="mono">{{ exit }}</span> <span class="cc__dim">→</span> <span class="mono cc__to">{{ to }}</span>
            </li>
            <li v-if="!Object.keys(a.routes).length" class="cc__dim">· sin salidas declaradas</li>
          </ul>
          <details v-if="a.prompt" class="cc__prompt" data-test="prompt">
            <summary class="cc__row">
              <span class="cc__chev" aria-hidden="true">▸</span>
              <span>Prompt</span>
              <span class="cc__dim mono">system {{ chars(a.prompt.system_chars) }} · turno {{ chars(a.prompt.task_chars) }}</span>
            </summary>
            <p v-if="clipped(a.prompt.system, a.prompt.system_chars) || clipped(a.prompt.task, a.prompt.task_chars)" class="cc__dim cc__note">
              Recortado: el completo lo trae el asistente (assistant_get_config con agent_id).
            </p>
            <pre v-if="a.prompt.system" class="cc__pre mono">{{ a.prompt.system }}</pre>
            <pre class="cc__pre mono">{{ a.prompt.task }}</pre>
          </details>
        </details>
      </li>
    </ul>
  </section>

  <section v-if="config.providers.length" class="cc" aria-label="Providers">
    <h2 class="cc__hd">Providers <span class="cc__n mono">{{ config.providers.length }}</span></h2>
    <ul class="cc__list">
      <li v-for="p in config.providers" :key="p.id" class="cc__row cc__row--flat">
        <span class="mono cc__id">{{ p.id }}</span>
        <span class="cc__dim mono">{{ p.type }}<template v-if="p.mode"> · {{ p.mode }}</template><template v-if="p.provider"> → {{ p.provider }}</template></span>
        <span v-if="p.max_concurrent !== undefined" class="cc__dim cc__end">hasta {{ p.max_concurrent }} a la vez</span>
      </li>
    </ul>
  </section>

  <section v-if="config.mcp.length" class="cc" aria-label="MCP">
    <h2 class="cc__hd">MCP <span class="cc__n mono">{{ config.mcp.length }}</span></h2>
    <ul class="cc__list">
      <li v-for="m in config.mcp" :key="m.id" class="cc__row cc__row--flat">
        <span class="mono cc__id">{{ m.id }}</span>
        <span class="cc__dim mono">{{ m.host }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.cc { display: flex; flex-direction: column; gap: 0.35rem; }
.cc__hd { display: flex; align-items: baseline; gap: 0.6rem; margin: 0; font-size: var(--fs-body); text-transform: uppercase; letter-spacing: var(--tracking-hd); }
.cc__n { color: var(--fg-dim); font-size: var(--fs-chrome); }
.cc__list { margin: 0; padding: 0; list-style: none; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
.cc__list > li + li { border-top: 1px solid var(--border-mute); }
.cc__row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.2rem 0.6rem; min-height: var(--tap-h); padding: 0.5rem 0.75rem; cursor: pointer; list-style: none; }
.cc__row::-webkit-details-marker { display: none; }
.cc__row:not(.cc__row--flat):hover { background: var(--panel-alt); }
.cc__row:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
/* Una fila que no se abre no es presionable: se lee a `--row-h` (R11). */
.cc__row--flat { min-height: 0; cursor: default; }
.cc__chev { flex: none; color: var(--fg-dim); font-size: var(--fs-micro); transition: transform 120ms ease; }
.cc__item[open] > summary .cc__chev { transform: rotate(90deg); }
.cc__id { color: var(--fg); font-size: var(--fs-body-sm); }
.cc__dim { color: var(--fg-dim); font-size: var(--fs-chrome); overflow-wrap: anywhere; }
.cc__end { margin-left: auto; }
.cc__routes { display: flex; flex-direction: column; gap: 0.2rem; margin: 0; padding: 0 0.75rem 0.75rem 2rem; list-style: none; font-size: var(--fs-chrome); overflow-wrap: anywhere; }
.cc__to { color: var(--info); }
.cc__warn { color: var(--warn); font-size: var(--fs-chrome); }
.cc__facts { display: grid; grid-template-columns: 1fr; gap: 0.15rem 0.75rem; margin: 0; padding: 0 0.75rem 0.5rem 2rem; font-size: var(--fs-chrome); overflow-wrap: anywhere; }
.cc__facts dd { display: flex; flex-wrap: wrap; gap: 0.2rem 0.6rem; margin: 0; }
@media (min-width: 640px) { .cc__facts { grid-template-columns: auto 1fr; } }
.cc__prompt { margin: 0 0.75rem 0.75rem 1.25rem; border-top: 1px solid var(--border-mute); }
.cc__prompt[open] > summary .cc__chev { transform: rotate(90deg); }
.cc__note { margin: 0 0 0.4rem; }
.cc__pre { max-height: 20rem; margin: 0 0 0.5rem; padding: 0.5rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--fs-chrome); background: var(--panel-alt); border-radius: var(--radius-sm); }
</style>
