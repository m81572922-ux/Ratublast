const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const { db, getConfigInt } = require('./db')
const { addCoins } = require('./coin')

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex')

function genReferral() {
  return crypto.randomBytes(4).toString('hex').toUpperCase()
}

function register({ username, email, password, ref }) {
  if (getConfigInt('registration_open') !== 1) throw new Error('registrasi ditutup')
  if (!username || username.length < 3) throw new Error('username minimal 3 char')
  if (!email || !email.includes('@')) throw new Error('email tidak valid')
  if (!password || password.length < 6) throw new Error('password minimal 6 char')

  const hash = bcrypt.hashSync(password, 10)
  let referredBy = null
  if (ref) {
    const r = db.prepare('SELECT id FROM users WHERE referral_code=?').get(ref)
    if (r) referredBy = r.id
  }

  let code, tries = 0
  do { code = genReferral(); tries++ }
  while (db.prepare('SELECT 1 FROM users WHERE referral_code=?').get(code) && tries < 10)

  const info = db.prepare('INSERT INTO users(username,email,password_hash,referral_code,referred_by,created_at) VALUES(?,?,?,?,?,?)')
    .run(username, email, hash, code, referredBy, Date.now())

  const userId = info.lastInsertRowid
  if (referredBy) {
    addCoins(referredBy, 50, 'referral', { new_user: username })
    addCoins(userId, 10, 'referral', { type: 'welcome' })
  } else {
    addCoins(userId, 10, 'referral', { type: 'welcome' })
  }
  return { id: userId, username, referral_code: code }
}

function login({ username, password }) {
  const u = db.prepare('SELECT * FROM users WHERE username=? OR email=?').get(username, username)
  if (!u) throw new Error('user tidak ditemukan')
  if (!bcrypt.compareSync(password, u.password_hash)) throw new Error('password salah')
  const token = jwt.sign({ uid: u.id, role: u.role }, JWT_SECRET, { expiresIn: '30d' })
  return { token, user: publicUser(u) }
}

function publicUser(u) {
  return { id: u.id, username: u.username, email: u.email, role: u.role, coin_balance: u.coin_balance, referral_code: u.referral_code }
}

function authMiddleware(req, res, next) {
  const h = req.headers.authorization || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : null
  if (!token) return res.status(401).json({ error: 'no token' })
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(payload.uid)
    if (!u) return res.status(401).json({ error: 'user gone' })
    req.user = u
    next()
  } catch (e) { res.status(401).json({ error: 'token invalid' }) }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'admin only' })
  next()
}

module.exports = { register, login, authMiddleware, adminOnly, publicUser, JWT_SECRET }
