const express = require('express')
const path = require('path')
const fs = require('fs')
const QRCode = require('qrcode')
const crypto = require('crypto')

const { db, getConfig, getConfigInt, setConfig, allConfig } = require('./db')
const { register, login, authMiddleware, adminOnly, publicUser } = require('./auth')
const { balance, history } = require('./coin')
const wd = require('./withdraw')
const { WhatsAppSession } = require('./whatsapp')
const { runDeviceBlast } = require('./blaster')

const PORT = process.env.PORT || 3000
const SESSION_ROOT = process.env.SESSION_DIR || path.join(__dirname, 'sessions')
fs.mkdirSync(SESSION_ROOT, { recursive: true })

const app = express()
app.use(express.json({ limit: '4mb' }))
app.use(express.static('public'))

const sessions = new Map()
const blastLoops = new Map()

function hooks() {
  return {
    onQR: (id) => updateDeviceState(id, 'pairing'),
    onOnline: (id) => {
      updateDeviceState(id, 'online')
      const dev = db.prepare('SELECT * FROM devices WHERE id=?').get(id)
      if (!dev || !dev.auto_blast) return
      startBlastForDevice(id)
    },
    onOffline: (id) => updateDeviceState(id, 'offline'),
    onLoggedOut: (id) => {
      updateDeviceState(id, 'loggedout')
      sessions.delete(id)
      const f = blastLoops.get(id); if (f) f.running = false
    },
  }
}
function updateDeviceState(id, state) {
  db.prepare('UPDATE devices SET state=? WHERE id=?').run(state, id)
}
function startBlastForDevice(deviceId) {
  const dev = db.prepare('SELECT * FROM devices WHERE id=?').get(deviceId)
  if (!dev) return
  const session = sessions.get(deviceId)
  if (!session || session.state !== 'online') return
  if (blastLoops.get(deviceId)?.running) return
  const flag = { running: true }
  blastLoops.set(deviceId, flag)
  runDeviceBlast({
    session, userId: dev.user_id, deviceId,
    category: dev.category,
    speedMode: dev.speed_mode || 'sedang',
    dailyCap: dev.daily_cap,
    isRunning: () => flag.running && session.state === 'online',
  }).catch(e => console.error('blast', deviceId, e))
    .finally(() => { flag.running = false })
}
function stopBlast(deviceId) {
  const f = blastLoops.get(deviceId); if (f) f.running = false
}

/* AUTH */
app.post('/api/auth/register', (req, res) => {
  try { res.json(register(req.body)) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/auth/login', (req, res) => {
  try { res.json(login(req.body)) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ ...publicUser(req.user), coin_balance: balance(req.user.id) })
})
app.post('/api/me/password', authMiddleware, (req, res) => {
  const { old_password, new_password } = req.body
  if (!old_password || !new_password) return res.status(400).json({ error: 'lengkapi field' })
  if (new_password.length < 6) return res.status(400).json({ error: 'password minimal 6 char' })
  const bcrypt = require('bcryptjs')
  if (!bcrypt.compareSync(old_password, req.user.password_hash))
    return res.status(400).json({ error: 'password lama salah' })
  const hash = bcrypt.hashSync(new_password, 10)
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, req.user.id)
  res.json({ ok: true })
})

/* DEVICES */
app.get('/api/devices', authMiddleware, async (req, res) => {
  const rows = db.prepare('SELECT * FROM devices WHERE user_id=? ORDER BY created_at DESC').all(req.user.id)
  const out = []
  for (const d of rows) {
    const s = sessions.get(d.id)
    let qrPng = null
    if (s?.qr) qrPng = await QRCode.toDataURL(s.qr, { width: 260, margin: 1 })
    out.push({
      ...d,
      runtime_state: s?.state || d.state,
      pairingCode: s?.pairingCode || null,
      qr: qrPng,
      blast_running: !!blastLoops.get(d.id)?.running,
    })
  }
  res.json(out)
})
app.post('/api/devices', authMiddleware, async (req, res) => {
  const { label } = req.body
  const count = db.prepare('SELECT COUNT(*) c FROM devices WHERE user_id=?').get(req.user.id).c
  if (count >= getConfigInt('max_devices_per_user'))
    return res.status(400).json({ error: 'maksimum ' + getConfigInt('max_devices_per_user') + ' device' })
  const id = crypto.randomUUID()
  db.prepare('INSERT INTO devices(id,user_id,label,state,auto_blast,category,delay_sec,daily_cap,speed_mode,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, req.user.id, label || 'device-' + (count + 1), 'offline', 1, 'all', 8, 40, 'sedang', Date.now())
  const s = new WhatsAppSession(id, SESSION_ROOT, hooks())
  sessions.set(id, s)
  s.connect().catch(e => console.error('connect', id, e))
  res.json({ ok: true, id })
})
app.get('/api/devices/:id/qr', authMiddleware, async (req, res) => {
  const dev = db.prepare('SELECT * FROM devices WHERE id=? AND user_id=?').get(req.params.id, req.user.id)
  if (!dev) return res.status(404).json({ error: 'device tidak ditemukan' })
  let s = sessions.get(req.params.id)
  if (!s) {
    s = new WhatsAppSession(req.params.id, SESSION_ROOT, hooks())
    sessions.set(req.params.id, s)
    s.connect().catch(() => {})
  }
  for (let i = 0; i < 16; i++) {
    if (s.qr || s.state === 'online') break
    await new Promise(r => setTimeout(r, 500))
  }
  if (s.state === 'online') return res.json({ qr: null, state: 'online' })
  if (!s.qr) return res.json({ qr: null, state: s.state })
  const png = await QRCode.toDataURL(s.qr, { width: 260, margin: 1 })
  res.json({ qr: png, state: s.state })
})
app.post('/api/devices/:id/pair', authMiddleware, async (req, res) => {
  const dev = db.prepare('SELECT * FROM devices WHERE id=? AND user_id=?').get(req.params.id, req.user.id)
  if (!dev) return res.status(404).json({ error: 'device tidak ditemukan' })
  const s = sessions.get(req.params.id) || new WhatsAppSession(req.params.id, SESSION_ROOT, hooks())
  if (!sessions.has(req.params.id)) { sessions.set(req.params.id, s); await s.connect().catch(() => {}) }
  try {
    const code = await s.requestPairingCode(req.body.phone)
    db.prepare('UPDATE devices SET phone=? WHERE id=?').run(req.body.phone, req.params.id)
    res.json({ code })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})
app.patch('/api/devices/:id', authMiddleware, (req, res) => {
  const { auto_blast, category, delay_sec, daily_cap, label, speed_mode } = req.body
  const sets = [], vals = []
  if (auto_blast !== undefined) { sets.push('auto_blast=?'); vals.push(auto_blast ? 1 : 0) }
  if (category !== undefined) { sets.push('category=?'); vals.push(category) }
  if (delay_sec !== undefined) { sets.push('delay_sec=?'); vals.push(parseInt(delay_sec, 10)) }
  if (daily_cap !== undefined) { sets.push('daily_cap=?'); vals.push(parseInt(daily_cap, 10)) }
  if (label !== undefined) { sets.push('label=?'); vals.push(label) }
  if (speed_mode !== undefined) {
    if (!['cepat','sedang','lambat'].includes(speed_mode))
      return res.status(400).json({ error: 'speed_mode harus cepat/sedang/lambat' })
    sets.push('speed_mode=?'); vals.push(speed_mode)
  }
  if (!sets.length) return res.json({ ok: true })
  vals.push(req.params.id, req.user.id)
  db.prepare('UPDATE devices SET ' + sets.join(',') + ' WHERE id=? AND user_id=?').run(...vals)
  res.json({ ok: true })
})
app.delete('/api/devices/:id', authMiddleware, async (req, res) => {
  const s = sessions.get(req.params.id)
  stopBlast(req.params.id)
  if (s) { await s.logout(); sessions.delete(req.params.id) }
  db.prepare('DELETE FROM devices WHERE id=? AND user_id=?').run(req.params.id, req.user.id)
  res.json({ ok: true })
})
app.post('/api/devices/:id/blast/start', authMiddleware, (req, res) => {
  const dev = db.prepare('SELECT * FROM devices WHERE id=? AND user_id=?').get(req.params.id, req.user.id)
  if (!dev) return res.status(404).json({ error: 'device tidak ditemukan' })
  const s = sessions.get(req.params.id)
  if (!s || s.state !== 'online') return res.status(400).json({ error: 'device belum online' })
  startBlastForDevice(req.params.id)
  res.json({ ok: true })
})
app.post('/api/devices/:id/blast/stop', authMiddleware, (req, res) => {
  stopBlast(req.params.id); res.json({ ok: true })
})

/* POOL GLOBAL */
app.get('/api/pool/info', authMiddleware, (req, res) => {
  const mc = db.prepare('SELECT COUNT(*) c FROM global_messages WHERE active=1').get().c
  const tc = db.prepare('SELECT COUNT(*) c FROM global_targets').get().c
  const cats = db.prepare('SELECT DISTINCT category FROM global_targets').all().map(r => r.category)
  res.json({
    messages_count: mc, targets_count: tc, categories: cats,
    cs_link: getConfig('cs_link') || '',
    cs_label: getConfig('cs_label') || 'Hubungi CS',
    cs_telegram_channel: getConfig('cs_telegram_channel') || '',
    cs_telegram_cs: getConfig('cs_telegram_cs') || '',
  })
})
app.get('/api/messages', authMiddleware, adminOnly, (req, res) => {
  res.json(db.prepare('SELECT * FROM global_messages ORDER BY id DESC').all())
})
app.post('/api/messages', authMiddleware, adminOnly, (req, res) => {
  const { body } = req.body
  if (!body || !body.trim()) return res.status(400).json({ error: 'kosong' })
  const info = db.prepare('INSERT INTO global_messages(body,active,created_at) VALUES(?,1,?)').run(body.trim(), Date.now())
  res.json({ ok: true, id: info.lastInsertRowid })
})
app.delete('/api/messages/:id', authMiddleware, adminOnly, (req, res) => {
  db.prepare('DELETE FROM global_messages WHERE id=?').run(req.params.id)
  res.json({ ok: true })
})
app.get('/api/targets', authMiddleware, adminOnly, (req, res) => {
  res.json(db.prepare('SELECT * FROM global_targets ORDER BY id DESC LIMIT 1000').all())
})
app.post('/api/targets/import', authMiddleware, adminOnly, (req, res) => {
  const csv = req.body.csv || ''
  const lines = csv.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  const insT = db.prepare('INSERT OR IGNORE INTO global_targets(phone,name,category,created_at) VALUES(?,?,?,?)')
  let added = 0
  const tx = db.transaction(() => {
    for (const line of lines) {
      const parts = line.split(',')
      const phone = (parts[0] || '').trim()
      const name = (parts[1] || '').trim()
      const category = (parts[2] || '').trim()
      const clean = phone.replace(/[^0-9]/g, '')
      if (!clean) continue
      const r = insT.run(clean, name, category || 'default', Date.now())
      if (r.changes) added++
    }
  })
  tx()
  res.json({ ok: true, added })
})
app.get('/api/targets/categories', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT DISTINCT category FROM global_targets').all()
  res.json(rows.map(r => r.category))
})
app.post('/api/targets/clear', authMiddleware, adminOnly, (req, res) => {
  db.prepare('DELETE FROM global_targets').run()
  res.json({ ok: true })
})

/* WALLET */
app.get('/api/wallet', authMiddleware, (req, res) => {
  const bal = balance(req.user.id)
  const rate = getConfigInt('coin_to_idr')
  res.json({
    balance_coin: bal,
    coin_to_idr: rate,
    min_withdraw_coin: getConfigInt('min_withdraw_coin'),
    idr_value: bal * rate,
  })
})
app.get('/api/wallet/history', authMiddleware, (req, res) => res.json(history(req.user.id, 100)))
app.post('/api/wallet/withdraw', authMiddleware, (req, res) => {
  try { res.json({ ok: true, ...wd.createWithdrawal(req.user.id, req.body) }) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.get('/api/wallet/withdrawals', authMiddleware, (req, res) => {
  res.json(wd.listMine(req.user.id))
})
app.delete('/api/wallet/history', authMiddleware, (req, res) => {
  db.prepare("DELETE FROM coin_ledger WHERE user_id=? AND reason='send'").run(req.user.id)
  res.json({ ok: true })
})
app.delete('/api/wallet/withdrawals', authMiddleware, (req, res) => {
  db.prepare("DELETE FROM withdrawals WHERE user_id=? AND status IN ('rejected','paid')").run(req.user.id)
  res.json({ ok: true })
})

/* REFERRAL */
app.get('/api/referral/users', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT id,username,coin_balance,created_at FROM users WHERE referred_by=? ORDER BY id DESC').all(req.user.id)
  res.json(rows)
})

/* ADMIN */
app.get('/api/admin/withdrawals', authMiddleware, adminOnly, (req, res) => {
  res.json(wd.listAll(req.query.status || null))
})
app.post('/api/admin/withdrawals/:id/:action', authMiddleware, adminOnly, (req, res) => {
  const { id, action } = req.params
  const { note = '' } = req.body
  if (!['approve', 'reject', 'paid'].includes(action))
    return res.status(400).json({ error: 'aksi tidak dikenal' })
  const map = { approve: 'approved', reject: 'rejected', paid: 'paid' }
  try {
    wd.setStatus(id, map[action], note, action === 'reject')
    res.json({ ok: true })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
app.delete('/api/admin/withdrawals/:id', authMiddleware, adminOnly, (req, res) => {
  db.prepare('DELETE FROM withdrawals WHERE id=?').run(req.params.id)
  res.json({ ok: true })
})
app.get('/api/admin/config', authMiddleware, adminOnly, (req, res) => res.json(allConfig()))
app.post('/api/admin/config', authMiddleware, adminOnly, (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) setConfig(k, v)
  res.json({ ok: true })
})
app.get('/api/admin/users', authMiddleware, adminOnly, (req, res) => {
  res.json(db.prepare('SELECT id,username,email,role,coin_balance,created_at FROM users ORDER BY id DESC').all())
})
app.delete('/api/admin/users/:id', authMiddleware, adminOnly, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id)
  if (!target) return res.status(404).json({ error: 'user tidak ada' })
  if (target.id === req.user.id) return res.status(400).json({ error: 'nggak bisa hapus diri sendiri' })
  if (target.role === 'admin') return res.status(400).json({ error: 'nggak bisa hapus admin' })
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM devices WHERE user_id=?').run(target.id)
    db.prepare('DELETE FROM coin_ledger WHERE user_id=?').run(target.id)
    db.prepare('DELETE FROM withdrawals WHERE user_id=?').run(target.id)
    db.prepare('DELETE FROM users WHERE id=?').run(target.id)
  })
  tx()
  res.json({ ok: true })
})
app.get('/api/admin/stats', authMiddleware, adminOnly, (req, res) => {
  const u = db.prepare('SELECT COUNT(*) c FROM users').get().c
  const d = db.prepare('SELECT COUNT(*) c FROM devices').get().c
  const dOn = db.prepare("SELECT COUNT(*) c FROM devices WHERE state='online'").get().c
  const t = db.prepare('SELECT COUNT(*) c FROM global_targets').get().c
  const m = db.prepare('SELECT COUNT(*) c FROM global_messages').get().c
  const sent = db.prepare('SELECT COALESCE(SUM(total_sent),0) s FROM devices').get().s
  const wdPend = db.prepare("SELECT COUNT(*) c FROM withdrawals WHERE status='pending'").get().c
  const wdAll = db.prepare('SELECT COUNT(*) c FROM withdrawals').get().c
  const coins = db.prepare('SELECT COALESCE(SUM(coin_balance),0) s FROM users').get().s
  res.json({ users: u, devices: d, devices_online: dOn, targets: t, messages: m,
             total_sent: sent, wd_pending: wdPend, wd_total: wdAll, coins_circulating: coins })
})

/* BOOT */
async function bootstrap() {
  const devices = db.prepare('SELECT * FROM devices').all()
  for (const d of devices) {
    const s = new WhatsAppSession(d.id, SESSION_ROOT, hooks())
    sessions.set(d.id, s)
    s.connect().catch(e => console.error('boot connect', d.id, e))
  }
  console.log('bootstrapped ' + devices.length + ' devices')

  const adminCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c
  if (!adminCount) {
    const bcrypt = require('bcryptjs')
    const pw = 'admin' + crypto.randomBytes(3).toString('hex')
    const code = crypto.randomBytes(4).toString('hex').toUpperCase()
    db.prepare('INSERT INTO users(username,email,password_hash,referral_code,role,created_at) VALUES(?,?,?,?,?,?)')
      .run('admin', 'admin@local', bcrypt.hashSync(pw, 10), code, 'admin', Date.now())
    console.log('=====================================')
    console.log('  ADMIN DEFAULT DIBUAT')
    console.log('  username: admin')
    console.log('  password: ' + pw)
    console.log('  >>> GANTI SEGERA setelah login <<<')
    console.log('=====================================')
  }
}
bootstrap().then(() => {
  app.listen(PORT, () => console.log('ratublast -> http://localhost:' + PORT))
})
