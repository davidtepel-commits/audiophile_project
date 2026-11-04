'use strict';
const { Pool } = require('pg');

/**
 * DATABASE_URL works for both local Postgres and Supabase
 * (Supabase: Project Settings -> Database -> Connection string, use the
 * session pooler on port 5432 for scripts; it bypasses RLS as the postgres role).
 */
function createPool() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (see .env.example)');
  const needsSsl = /supabase\.(co|com)|sslmode=require/.test(url);
  return new Pool({ connectionString: url, max: 5, ssl: needsSsl ? { rejectUnauthorized: false } : undefined });
}

module.exports = { createPool };
