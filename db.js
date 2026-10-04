const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')

const dir = process.env.DATA_DIR || path.join(__dirname, 'data')
fs.mkdirSync(dir, { recursive: true })
const db = new Database(path.join(dir, 'app.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  referral_code TEXT UNIQUE NOT NULL,
  referred_by INTEGER,
  role TEXT DEFAULT 'user',
  coin_balance INTEGER DEFAULT 0,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  phone TEXT, label TEXT,
  state TEXT DEFAULT 'offline',
  auto_blast INTEGER DEFAULT 0,
  category TEXT DEFAULT 'all',
  delay_sec INTEGER DEFAULT 8,
  daily_cap INTEGER DEFAULT 40,
  sent_today INTEGER DEFAULT 0,
  day_key TEXT,
  total_sent INTEGER DEFAULT 0,
  total_fail INTEGER DEFAULT 0,
  speed_mode TEXT DEFAULT 'sedang',
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS coin_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  device_id TEXT,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  meta TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  account_no TEXT NOT NULL,
  account_name TEXT NOT NULL,
  bank_code TEXT,
  amount_coin INTEGER NOT NULL,
  amount_idr INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',
  admin_note TEXT,
  created_at INTEGER,
  processed_at INTEGER
);
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS global_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL, active INTEGER DEFAULT 1, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS global_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL, name TEXT,
  category TEXT DEFAULT 'default',
  claimed_at INTEGER DEFAULT 0,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON coin_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_wd_user ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_wd_status ON withdrawals(status);
`)

try { db.exec("ALTER TABLE devices ADD COLUMN speed_mode TEXT DEFAULT 'sedang'") } catch (e) {}
try { db.exec("ALTER TABLE global_targets ADD COLUMN claimed_at INTEGER DEFAULT 0") } catch (e) {}

const defaults = {
  coin_per_send: '1',
  coin_to_idr: '100',
  min_withdraw_coin: '100',
  max_devices_per_user: '4',
  registration_open: '1',
  referral_bonus: '50',
  referral_welcome: '10',
  cs_link: '',
  cs_label: 'Hubungi CS',
  cs_telegram_channel: '',
  cs_telegram_cs: '',
}
const ins = db.prepare('INSERT OR IGNORE INTO config(key,value) VALUES(?,?)')
for (const [k, v] of Object.entries(defaults)) ins.run(k, v)

function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key=?').get(key)
  return row ? row.value : null
}
function getConfigInt(key) {
  const n = parseInt(getConfig(key), 10)
  return Number.isFinite(n) ? n : 0
}
function setConfig(key, val) {
  db.prepare("INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(val))
}
function allConfig() {
  const rows = db.prepare('SELECT * FROM config').all()
  return Object.fromEntries(rows.map(r => [r.key, r.value]))
}

module.exports = { db, getConfig, getConfigInt, setConfig, allConfig }
