// Thin wrapper — exports only the DB connection and config dir.
// All SQL lives in the individual SqliteXxxRepository implementations.
export { getDb, CONFIG_DIR } from '../../db.js'
