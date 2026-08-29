import type { Migration } from './runner.js'

// Agrega `rules.schedule` — la expresión cron que hace tickear una regla.
//
// Vive en la regla y no en una tabla aparte: son dos cosas que siempre se
// editan juntas, y separarlas dejaría posible el estado sin sentido de un
// schedule que no apunta a ninguna regla.
//
// Nullable sin default: la enorme mayoría de las reglas reacciona a eventos que
// pasan afuera y no tiene schedule. Un `''` como default obligaría a cada
// lector a distinguir "vacío" de "no configurado".

const migration: Migration = {
  id: '062-rules-schedule',
  description: 'Add rules.schedule — cron expression for the schedule.tick producer',
  up(db) {
    db.run('ALTER TABLE rules ADD COLUMN schedule TEXT')
    // El barrido de cron pregunta "¿qué reglas tienen schedule?" cada minuto;
    // sin índice eso es un scan de la tabla entera por tick.
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_rules_schedule ON rules(schedule) WHERE schedule IS NOT NULL',
    )
  },
}

export default migration
