---
description: Crea una nueva migración SQLite consistente y la registra en runner.ts
argument-hint: <nombre-en-kebab>
allowed-tools: Read, Write, Edit, Bash(ls:*), Bash(bun *), Grep, Glob
model: sonnet
---

Delegar al subagent `migration-writer` con el argumento `$ARGUMENTS`.

Si `$ARGUMENTS` está vacío, pregunta al usuario qué migración quiere. Si viene, lanza al subagent con: "Crea una nueva migración llamada '$ARGUMENTS'".
