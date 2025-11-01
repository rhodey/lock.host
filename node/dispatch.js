const http2 = require('http2')
const crypto = require('crypto')
const sodium = require('libsodium-wrappers')
const duplex = require('/runtime/attest-duplex.js')
const { Dispatcher } = require('undici')

/*
 * const dispatcher = new FetchHelper(testFn)
 * const response = await fetch('https://example.com/api/idk', { dispatcher })
 */
class FetchHelper extends Dispatcher {
  constructor(testFn, sessionPath=null, sessions=null) {
    super()
    this.testFn = testFn
    this.sessionPath = sessionPath ?? '/.well-known/lockhost'
    this.sessions = sessions
  }

  sendAndGetBody(url, cookie, data) {
    return new Promise((res, rej) => {
      let req = null
      const [host, path] = duplex.urlToHostAndPath(url)
      const conn = http2.connect(host, { rejectUnauthorized: false })
      const onErr = (err) => {
        rej(new Error(`session = ${err.message}`))
        req && req.destroy()
        conn.destroy()
      }

      conn.on('error', onErr)
      conn.on('close', () => onErr(new Error('session = close')))
      req = conn.request({ ':method': 'POST', ':path': `${path}/session`, 'cookie': `sessionlh=${cookie}` })
      req.on('error', onErr)

      let status = null
      req.on('response', (headers) => status = headers[':status'])
      let body = []
      req.on('data', (data) => body.push(data))

      req.on('end', () => {
        if (status !== 200) {
          rej(new Error(`session = status ${status}`))
          conn.close()
          return
        }
        try {
          body = Buffer.concat(body).toString('utf8')
          body = JSON.parse(body)
          res(body)
        } catch (err) {
          rej(new Error('session = reply not json'))
        }
        conn.close()
      })
      req.end(data)
    })
  }

  async read(iter) {
    const data = []
    for await (const buf of iter) { data.push(Buffer.from(buf)) }
    return Buffer.concat(data)
  }

  async startSession(url) {
    const nonce = crypto.randomBytes(32).toString('base64')
    const hello = await duplex.sendHello(url, nonce, 'json')
    let state = await duplex.startState(hello, nonce, this.testFn)
    state = [state.cookie, state.sessionKeys.sharedTx, state.sessionKeys.sharedRx]
    if (this.sessions) { this.sessions.set(state) }
    return state
  }

  encrypt(data, state) {
    const key = state[1]
    let nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
    let encrypted = sodium.crypto_secretbox_easy(data, nonce, key)
    nonce = Buffer.from(nonce).toString('base64')
    encrypted = Buffer.from(encrypted).toString('base64')
    data = { nonce, encrypted }
    return JSON.stringify(data)
  }

  async dispatch(opts, handler) {
    await sodium.ready
    const url = `${opts.origin}${this.sessionPath}`

    let state = null
    if (this.sessions) { state = this.sessions.get() }
    if (!state) { state = await this.startSession(url) }

    const path = opts.path
    const method = opts.method
    let headers = opts.headers
    let data = { path, method, headers }
    opts.body && (opts.body = await this.read(opts.body))
    opts.body && (data.body = opts.body.toString('base64'))
    data = JSON.stringify(data)
    data = Buffer.from(data)
    let json = this.encrypt(data, state)

    try {
      const cookie = state[0]
      json = await this.sendAndGetBody(url, cookie, json)
    } catch (err) {
      if (!err.message.includes('session = status 404')) { throw err }
      state = await this.startSession(url)
      const cookie = state[0]
      json = this.encrypt(data, state)
      json = await this.sendAndGetBody(url, cookie, json)
    }

    const key = state[2]
    json.nonce = Buffer.from(json.nonce, 'base64')
    json.encrypted = Buffer.from(json.encrypted, 'base64')
    json = sodium.crypto_secretbox_open_easy(json.encrypted, json.nonce, key)

    json = Buffer.from(json)
    json = JSON.parse(json.toString('utf8'))

    let { status, body } = json
    body = Buffer.from(body, 'base64')
    headers = json.headers

    const resume = () => {}
    handler.onHeaders(status, headers, resume, '' + status)
    handler.onData(body)
    handler.onComplete(null)
  }
}

module.exports = { FetchHelper }
