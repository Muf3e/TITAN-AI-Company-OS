const fs = require('fs');
const path = require('path');

const LOCAL_DB = path.join(__dirname, '..', 'data', 'db.json');
const DATABASE_URL = process.env.DATABASE_URL || '';
let pgPool = null;

async function getPool() {
  if (!DATABASE_URL) return null;
  if (pgPool) return pgPool;
  let pg;
  try { pg = require('pg'); } catch (err) { throw new Error('DATABASE_URL is set but the pg package is unavailable'); }
  pgPool = new pg.Pool({ connectionString: DATABASE_URL, max: 5, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  return pgPool;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function readLocal() { return JSON.parse(fs.readFileSync(LOCAL_DB, 'utf8')); }
function writeLocal(state) { fs.mkdirSync(path.dirname(LOCAL_DB), {recursive:true}); const tmp = `${LOCAL_DB}.tmp`; fs.writeFileSync(tmp, JSON.stringify(state,null,2)); fs.renameSync(tmp, LOCAL_DB); }

async function ensureSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS titan_state (id TEXT PRIMARY KEY, version BIGINT NOT NULL DEFAULT 0, state JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

async function loadState() {
  const pool = await getPool();
  if (!pool) { const state = readLocal(); state._persistence={mode:'local-json',version:Number(state._version||0)}; return state; }
  await ensureSchema(pool);
  const result = await pool.query('SELECT version, state FROM titan_state WHERE id = $1',['default']);
  if (!result.rowCount) {
    const seed = readLocal(); delete seed._persistence;
    const inserted = await pool.query('INSERT INTO titan_state (id, version, state) VALUES ($1,$2,$3::jsonb) ON CONFLICT (id) DO NOTHING RETURNING version,state',['default',0,JSON.stringify(seed)]);
    if (inserted.rowCount) { seed._version=0; seed._persistence={mode:'postgres',version:0}; return seed; }
    const retry = await pool.query('SELECT version,state FROM titan_state WHERE id=$1',['default']); const row=retry.rows[0]; const state=row.state; state._version=Number(row.version); state._persistence={mode:'postgres',version:Number(row.version)}; return state;
  }
  const row=result.rows[0], state=row.state; state._version=Number(row.version); state._persistence={mode:'postgres',version:Number(row.version)}; return state;
}

async function saveState(state) {
  const pool = await getPool(); const expected=Number(state._version||0), next=expected+1; const clean=clone(state); delete clean._persistence; delete clean._version;
  if (!pool) { clean._version=next; writeLocal(clean); state._version=next; state._persistence={mode:'local-json',version:next}; return state; }
  await ensureSchema(pool);
  const result=await pool.query('UPDATE titan_state SET version=$1,state=$2::jsonb,updated_at=NOW() WHERE id=$3 AND version=$4',[next,JSON.stringify(clean),'default',expected]);
  if (result.rowCount!==1) { const err=new Error('State version conflict; retry the operation'); err.code='STATE_CONFLICT'; throw err; }
  state._version=next; state._persistence={mode:'postgres',version:next}; return state;
}

function mode(){ return DATABASE_URL ? 'postgres' : 'local-json'; }
module.exports={loadState,saveState,mode};
