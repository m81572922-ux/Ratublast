const path = require('path')
const fs = require('fs')
const pino = require('pino')
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require('@whiskeysockets/baileys')

const logger = pino({ level: 'silent' })
const todayKey = () => new Date().toISOString().slice(0, 10)

class WhatsAppSession {
  constructor(id, sessionRoot, hooks = {}) {
    this.id = id
    this.dir = path.join(sessionRoot, id)
    this.sock = null
    this.state = 'offline'
    this.pairingCode = null
    this.qr = null
    this.hooks = hooks
    this.stats = { success: 0, fail: 0, sentToday: 0, dayKey: todayKey() }
    fs.mkdirSync(this.dir, { recursive: true })
  }

  resetDaily() {
    const k = todayKey()
    if (k !== this.stats.dayKey) { this.stats.dayKey = k; this.stats.sentToday = 0 }
  }

  async connect() {
    const { state, saveCreds } = await useMultiFileAuthState(this.dir)
    const { version } = await fetchLatestBaileysVersion()

    this.sock = makeWASocket({
      version, logger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: Browsers.ubuntu('Chrome'),
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    })

    this.state = 'connecting'
    this.sock.ev.on('creds.update', saveCreds)

    this.sock.ev.on('connection.update', (u) => {
      const { connection, lastDisconnect, qr } = u
      if (qr) { this.qr = qr; this.state = 'pairing'; this.hooks.onQR?.(this.id, qr) }
      if (connection === 'open') {
        this.qr = null; this.pairingCode = null; this.state = 'online'
        this.hooks.onOnline?.(this.id)
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          this.state = 'loggedout'; this.hooks.onLoggedOut?.(this.id)
        } else {
          this.state = 'offline'; this.hooks.onOffline?.(this.id)
          setTimeout(() => this.connect().catch(() => {}), 3000)
        }
      }
    })
  }

  async requestPairingCode(phone) {
    if (!this.sock) await this.connect()
    await new Promise(r => setTimeout(r, 1500))
    const num = phone.replace(/[^0-9]/g, '')
    this.pairingCode = await this.sock.requestPairingCode(num)
    this.state = 'pairing'
    return this.pairingCode
  }

  async sendText(number, text) {
    if (this.state !== 'online') throw new Error('device offline')
    const jid = number.replace(/[^0-9]/g, '') + '@s.whatsapp.net'
    return await this.sock.sendMessage(jid, { text })
  }

  async logout() { try { await this.sock?.logout() } catch {} this.state = 'loggedout' }
}

module.exports = { WhatsAppSession }
