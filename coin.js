const { db, getConfigInt } = require('./db')

function addCoins(userId, delta, reason, meta = {}, deviceId = null) {
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO coin_ledger(user_id,device_id,delta,reason,meta,created_at) VALUES(?,?,?,?,?,?)')
      .run(userId, deviceId, delta, reason, JSON.stringify(meta), Date.now())
    db.prepare('UPDATE users SET coin_balance = coin_balance + ? WHERE id = ?').run(delta, userId)
  })
  tx()
}

function balance(userId) {
  const row = db.prepare('SELECT coin_balance FROM users WHERE id=?').get(userId)
  return row ? row.coin_balance : 0
}

function creditSend(userId, deviceId, phone) {
  const amount = getConfigInt('coin_per_send')
  if (amount <= 0) return 0
  addCoins(userId, amount, 'send', { phone }, deviceId)
  return amount
}

function history(userId, limit = 50) {
  return db.prepare('SELECT * FROM coin_ledger WHERE user_id=? ORDER BY id DESC LIMIT ?').all(userId, limit)
}

module.exports = { addCoins, balance, creditSend, history }
