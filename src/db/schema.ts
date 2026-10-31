// ── Schema barrel ──────────────────────────────────────────────────────────
// Types and helpers continue to come from the SQLite schema because the
// repository layer is written against a shared logical shape.
//
// Table objects are different: Drizzle encodes values using the table's
// column metadata. Repositories must therefore resolve the active table set
// at query-build time so PostgreSQL writes use PostgreSQL timestamp/boolean
// encoders instead of SQLite ones.
// ──────────────────────────────────────────────────────────────────────────

import { getDialect } from './connection';
import * as sqliteSchema from './schema.sqlite';
import * as pgSchema from './schema.pg';

export function getSchema(): typeof sqliteSchema {
	return (getDialect() === 'postgres' ? pgSchema : sqliteSchema) as unknown as typeof sqliteSchema;
}

export * from './schema.sqlite';
