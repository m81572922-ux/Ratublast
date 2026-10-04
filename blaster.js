const { db } = require('./db')
const { creditSend } = require('./coin')

const SPEED_MODES = {
  cepat:  { minDelay: 3,  maxDelay: 8,  pauseAfter: 20, pauseMin: 15,  pauseMax: 30  },
  sedang: { minDelay: 8,  maxDelay: 20, pauseAfter: 15, pauseMin: 30,  pauseMax: 60  },
  lambat: { minDelay: 20, maxDelay: 60, pauseAfter: 10, pauseMin: 60,  pauseMax: 180 },
}

function spin(text, vars) {
  return text.replace(/\{([^{}]+)\}/g, (m, inner) => {
    if (inner.includes('|')) {
      const o = inner.split('|'); return o[Math.floor(Math.random() * o.length)]
    }
    return vars[inner] ?? m
  })
}

function pickMessages() {
  return db.prepare('SELECT body FROM global_messages WHERE active=1').all().map(r => r.body)
}

let _claimReady = false
function ensureClaimCol() {
  if (_claimReady) return
  try { db.exec("ALTER TABLE global_targets ADD COLUMN claimed_at INTEGER DEFAULT 0") } catch(e){}
  _claimReady = true
}

function pickOneTarget(category) {
  ensureClaimCol()
  const cutoff = Date.now() - 5 * 60 * 1000
  const tx = db.transaction(() => {
    let row
    if (!category || category === 'all') {
      row = db.prepare('SELECT id FROM global_targets WHERE (claimed_at IS NULL OR claimed_at < ?) ORDER BY RANDOM() LIMIT 1').get(cutoff)
    } else {
      row = db.prepare('SELECT id FROM global_targets WHERE category=? AND (claimed_at IS NULL OR claimed_at < ?) ORDER BY RANDOM() LIMIT 1').get(category, cutoff)
    }
    if (!row) return null
    db.prepare('UPDATE global_targets SET claimed_at=? WHERE id=?').run(Date.now(), row.id)
    return db.prepare('SELECT * FROM global_targets WHERE id=?').get(row.id)
  })
  return tx()
}

function releaseTarget(id) {
  try { db.prepare('UPDATE global_targets SET claimed_at=0 WHERE id=?').run(id) } catch(e){}
}
function removeTarget(id) {
  try { db.prepare('DELETE FROM global_targets WHERE id=?').run(id) } catch(e){}
}

async function runDeviceBlast({ session, userId, deviceId, category, speedMode, dailyCap, isRunning }) {
  const messages = pickMessages()
  if (!messages.length) { console.log('blast', deviceId, 'pool pesan kosong'); return }

  const mode = SPEED_MODES[speedMode] || SPEED_MODES.sedang
  console.log('blast ' + deviceId + ' start · mode=' + speedMode + ' · cap=' + dailyCap)

  while (true) {
    if (!isRunning()) break
    session.resetDaily()
    if (session.state !== 'online') break
    if (session.stats.sentToday >= dailyCap) break

    const target = pickOneTarget(category)
    if (!target) { console.log('blast ' + deviceId + ' pool kosong'); break }

    const raw = messages[Math.floor(Math.random() * messages.length)]
    const text = spin(raw, { nama: target.name || '', nomor: target.phone })

    try {
      await session.sendText(target.phone, text)
      session.stats.success++; session.stats.sentToday++
      creditSend(userId, deviceId, target.phone)
      db.prepare('UPDATE devices SET sent_today=sent_today+1, total_sent=total_sent+1, day_key=? WHERE id=?').run(session.stats.dayKey, deviceId)
      removeTarget(target.id)
    } catch (e) {
      session.stats.fail++
      db.prepare('UPDATE devices SET total_fail=total_fail+1 WHERE id=?').run(deviceId)
      releaseTarget(target.id)
    }

    const delay = (mode.minDelay + Math.random() * (mode.maxDelay - mode.minDelay)) * 1000
    const extra = (session.stats.sentToday % mode.pauseAfter === 0)
      ? (mode.pauseMin + Math.random() * (mode.pauseMax - mode.pauseMin)) * 1000 : 0
    await new Promise(r => setTimeout(r, delay + extra))
  }
  console.log('blast ' + deviceId + ' done · terkirim sesi ini=' + session.stats.sentToday)
}

module.exports = { runDeviceBlast, spin, SPEED_MODES }
