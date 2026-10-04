const { db, getConfigInt } = require('./db')
const { addCoins, balance } = require('./coin')

const ALLOWED = ['dana', 'gopay', 'ovo', 'shopeepay', 'bank']

function createWithdrawal(userId, { method, account_no, account_name, bank_code, coin }) {
  if (!ALLOWED.includes(method)) throw new Error('metode tidak dikenal')
  if (!account_no || !account_name) throw new Error('rekening tidak lengkap')
  if (method === 'bank' && !bank_code) throw new Error('bank_code wajib untuk transfer bank')

  const amt = parseInt(coin, 10)
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('jumlah tidak valid')
  if (amt < getConfigInt('min_withdraw_coin'))
    throw new Error('minimum ' + getConfigInt('min_withdraw_coin') + ' koin')

  const bal = balance(userId)
  if (amt > bal) throw new Error('saldo tidak cukup')

  const idr = amt * getConfigInt('coin_to_idr')

  const tx = db.transaction(() => {
    addCoins(userId, -amt, 'withdraw', { method, account_no }, null)
    const info = db.prepare('INSERT INTO withdrawals(user_id,method,account_no,account_name,bank_code,amount_coin,amount_idr,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(userId, method, account_no, account_name, bank_code || null, amt, idr, 'pending', Date.now())
    return info.lastInsertRowid
  })
  return { id: tx(), amount_idr: idr, amount_coin: amt }
}

function listMine(userId) {
  return db.prepare('SELECT * FROM withdrawals WHERE user_id=? ORDER BY id DESC').all(userId)
}

function listAll(status = null) {
  const q = status
    ? 'SELECT w.*, u.username FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE w.status=? ORDER BY w.id DESC'
    : 'SELECT w.*, u.username FROM withdrawals w JOIN users u ON u.id=w.user_id ORDER BY w.id DESC'
  return status ? db.prepare(q).all(status) : db.prepare(q).all()
}

function setStatus(id, status, note = '', refund = false) {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id=?').get(id)
  if (!w) throw new Error('WD tidak ditemukan')
  if (w.status !== 'pending') throw new Error('WD sudah diproses')

  const tx = db.transaction(() => {
    db.prepare('UPDATE withdrawals SET status=?, admin_note=?, processed_at=? WHERE id=?').run(status, note, Date.now(), id)
    if (status === 'rejected') {
      addCoins(w.user_id, w.amount_coin, 'adjust', { refund_for: id, reason: note })
    }
  })
  tx()
}

module.exports = { createWithdrawal, listMine, listAll, setStatus, ALLOWED }
