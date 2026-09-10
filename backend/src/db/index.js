import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Single shared connection pool. Neon (and most Postgres providers) work
// fine with this out of the box. If you ever swap databases, this is the
// one file that needs to change — nothing else in the app talks to
// Postgres directly.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// node-postgres requires this: an idle client in the pool that hits a
// network-level error (dropped connection, reset socket) emits an 'error'
// event on the pool. With no listener attached, that becomes an uncaught
// exception that crashes the entire process — confirmed against a real
// connection reset, not a hypothetical (see pg's own docs on this). This
// just logs it; the pool discards the broken client and reconnects on the
// next query.
pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client:', err);
});

export async function query(text, params) {
  return pool.query(text, params);
}
