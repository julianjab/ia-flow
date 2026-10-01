# @ia-flow/shell-tools

Ver `README.md` para el contrato de uso; esto es guía específica para trabajar en el código.

## Estructura

```
src/
├── tokenize.ts       string → argv, SIN shell — corta con error ante metacaracteres fuera de comillas
├── BashPolicy.ts      matchesPattern()/isDenied()/isAllowed() + DEFAULT_DENY_PATTERNS
├── BashRunTool.ts      única Tool del paquete — extiende SchemaTool (input en zod) directo, sin base intermedia
├── index.ts
└── tests/               tokenize.test.ts, BashPolicy.test.ts, BashRunTool.test.ts,
                         BashRunTool.credential.test.ts, index.test.ts
```

Package chico, sin subcarpetas (una sola tool) — a diferencia de `github-tools`/`fs-tools`, acá
no hay una jerarquía de clases que valga la pena: `BashRunTool` es la única, así que implementa
`Tool` directo en vez de extender una base abstracta con una sola subclase.

## Por qué `spawn(argv[0], argv.slice(1), { shell: false })` y no `exec`

`shell: false` es la garantía real de "sin pipes/redirecciones/expansión" — con un shell de por
medio, cualquier metacarácter que `tokenize()` dejó pasar (porque estaba entre comillas, donde es
inerte) volvería a ser interpretado. `tokenize()` y `shell: false` son las DOS mitades de la
misma garantía: una sin la otra no alcanza.

## `matchesPattern` — el matcher posicional

Ver el comentario largo en `BashPolicy.ts` y la sección "Límites honestos" del README antes de
tocar esto. Resumen: patrón tokenizado por espacio, comparado token a token contra el `argv` real;
`*` al final = "el resto, 0+ tokens"; `*` en medio = "exactamente un token"; un token que termina
en `*` = prefix match de ESE token.

## Tests — con `spawn` real, no mocks de `child_process`

`BashRunTool.test.ts` corre comandos reales (`echo`, `pwd`, `ls`) contra un `baseDir` temporal
real (`mkdtemp`) — mockear `child_process.spawn` no probaría la garantía que más importa (`shell:
false` de verdad, `cwd` de verdad). Un exit code no-cero NO hace que el `handler` tire — el
resultado (`status`/`stdout`/`stderr`) vuelve igual, y es el modelo el que decide qué hacer con
un comando que falló; sólo tira por policy violation, comando vacío, o error real de `spawn`
(binario inexistente).

## Antes de tocar código

```bash
bun run --filter @ia-flow/shell-tools typecheck
bun run --filter @ia-flow/shell-tools test
```

Source-only: sin build ni `dist/` — los `exports` apuntan a `src/*.ts` y los consumidores lo leen directo.
