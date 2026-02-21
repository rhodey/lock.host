const http2 = require('http2')
const cookies = require('cookie')
const crypto = require('crypto')
const sodium = require('libsodium-wrappers')
const attest = require('/runtime/attest.js')
const attestParse = require('/runtime/attest-parse.js')
const { EncryptStream, DecryptStream } = require('/runtime/streams.js')
const { PackrStream, UnpackrStream } = require('msgpackr')

const netTimeout = 5 * 1000

const noop = () => {}

// use less timers by group 100ms
const timeout = (ms) => {
  let timer = null
  const timedout = new Promise((res, rej) => {
    const now = Date.now()
    let next = now + ms
    next = next - (next % 100)
    next = (100 + next) - now
    timer = setTimeout(rej, next, null)
  })
  return [timer, timedout]
}

function writeStream(stream, data) {
  const [timer, timedout] = timeout(netTimeout)
  const write = new Promise((res, rej) => {
    timedout.catch((err) => rej(new Error(`write stream timeout`)))
    stream.write(data, (err) => {
      if (!err) { return res() }
      rej(err)
    })
  })
  write.catch(noop).finally(() => clearTimeout(timer))
  return write
}

function endStream(stream, delay=netTimeout) {
  if (stream.destroyed) { return }
  const [timer, timedout] = timeout(delay)
  const end = () => {
    clearTimeout(timer)
    stream.destroy()
    stream.removeListener('error', end)
    stream.removeListener('close', end)
  }
  timedout.catch(end)
  stream.once('error', end)
  if (stream.closed) { return }
  stream.once('close', end)
  try {
    if (typeof stream.end === 'function') { return stream.end() }
    stream.close()
  } catch (err) {
    stream.destroy()
  }
}

const wellKnown = '/.well-known/lockhost'

function urlToHostAndPath(url) {
  let host = url.split('https://')[1]
  host = host.split('/').slice(0, 1)[0]
  host = host.includes(':') ? host : `${host}:443`
  host = `https://${host}`
  let path = url.split('https://')[1]
  path = '/' + path.split('/').slice(1).join('/')
  path = path === '/' ? wellKnown : path
  return [host, path]
}

function sendHello(url, nonce, envelope='tcp') {
  const keys = sodium.crypto_kx_keypair()
  const publicKey = Buffer.from(keys.publicKey).toString('base64')
  const params = new URLSearchParams({ publicKey, nonce, envelope })

  return new Promise((res, rej) => {
    let req = null
    const [host, path] = urlToHostAndPath(url)
    const conn = http2.connect(host, { rejectUnauthorized: false })
    const onErr = (err) => {
      rej(new Error(`hello = ${err.message}`))
      req && req.destroy()
      conn.destroy()
    }

    conn.on('error', onErr)
    conn.once('close', () => onErr(new Error('hello = close')))
    req = conn.request({ ':path': `${path}/hello?${params.toString()}` })
    req.on('error', onErr)

    let status = null
    let cookie = null
    let body = []

    req.on('response', (headers) => {
      status = headers[':status']
      cookie = headers['set-cookie'] || ''
      cookie = cookie[0] || ''
      cookie = cookies.parse(cookie)
      cookie = cookie?.sessionlh
    })

    req.on('data', (data) => body.push(data))
    req.on('end', () => {
      if (status !== 200) {
        res({ status })
        endStream(conn)
        return
      }
      body = Buffer.concat(body).toString('utf8')
      try {
        body = JSON.parse(body)
        res({ status, cookie, body, keys })
      } catch (err) {
        rej(new Error('hello = reply not json'))
      }
      endStream(conn)
    })

    req.end()
  })
}

async function startState(hello, nonce, testFn) {
  const { status, cookie, body, keys } = hello
  if (status !== 200) {
    throw new Error(`hello = status ${status}`)
  } else if (typeof cookie !== 'string') {
    throw new Error(`hello = no cookie`)
  }

  let { attestDoc } = body
  if (typeof attestDoc !== 'string') { throw new Error(`hello = no doc`) }
  attestDoc = Buffer.from(attestDoc, 'base64')
  const ok = await attestParse(attestDoc)
  const { publicKey, nonce: nonce2, PCR, userData } = ok

  if (nonce !== nonce2.toString('base64')) {
    throw new Error('hello = doc nonce not ok')
  }

  const attestData = await testFn(PCR, userData)

  try {
    const sessionKeys = sodium.crypto_kx_client_session_keys(
      keys.publicKey, keys.privateKey,
      publicKey
    )
    return { cookie, sessionKeys, attestData }
  } catch (err) {
    throw new Error('hello = doc key not ok')
  }
}

async function connect(url, testFn) {
  await sodium.ready
  const nonce = crypto.randomBytes(32).toString('base64')
  const hello = await sendHello(url, nonce)
  const state = await startState(hello, nonce, testFn)

  const { attestData } = state
  const { cookie, sessionKeys: keys } = state

  return new Promise((res, rej) => {
    let req = null
    const [host, path] = urlToHostAndPath(url)
    const conn = http2.connect(host, { rejectUnauthorized: false })
    const onErr = (err) => {
      rej(new Error(`session = ${err.message}`))
      req && endStream(req)
      endStream(conn)
    }

    conn.on('error', onErr)
    conn.once('close', () => onErr(new Error('session = close')))
    req = conn.request({ ':method': 'POST', ':path': `${path}/session`, 'cookie': `sessionlh=${cookie}` })
    req.on('error', onErr)

    req.on('response', (headers) => {
      const status = headers[':status']
      if (status !== 200) {
        rej(new Error(`session = status ${status}`))
        endStream(req)
        endStream(conn)
        return
      }

      const encrypt = new EncryptStream(keys.sharedTx)
      const decrypt = new DecryptStream(keys.sharedRx)
      encrypt.on('error', onErr)
      decrypt.on('error', onErr)

      const close = () => {
        rej(new Error(`session = close`))
        endStream(encrypt)
        endStream(decrypt)
        endStream(conn)
      }

      encrypt.once('close', close)
      decrypt.once('close', close)
      conn.once('close', close)

      encrypt.pipe(req)
      req.pipe(decrypt)

      res([encrypt, decrypt, attestData])
    })
  })
}

// both sides attest
async function client(url, testFn, log, userData=null) {
  let [timer, timedout] = timeout(netTimeout)
  const conn = new Promise((res, rej) => {
    timedout.catch((err) => {
      rej(new Error(`attest client timeout`))
      timedout = true
    })
    connect(url, testFn).then((ok) => {
      // server has attested
      const [encrypt, decrypt, attestData] = ok
      const pack = new PackrStream()
      const unpack = new UnpackrStream()

      const close = (err='') => {
        log(`warn attest client close`, url, err)
        endStream(encrypt)
        endStream(decrypt)
        endStream(pack)
        endStream(unpack)
      }

      if (timedout === true) { return close('timedout') }
      encrypt.on('error', close)
      decrypt.on('error', close)
      pack.on('error', close)
      unpack.on('error', close)

      encrypt.once('close', close)
      decrypt.once('close', close)
      pack.once('close', close)
      unpack.once('close', close)

      // client is inside Nitro Enclave
      const attestEnclave = (nonce) => {
        const pubKey = null
        nonce = Buffer.from(nonce, 'base64')
        attest(pubKey, nonce, userData).then((doc) => {
          doc = doc.toString('base64')
          writeStream(pack, { type: 'attest_doc', doc }).catch((err) => {
            log(`error attest client write attest_doc`, url, err)
            close()
          })
        }).catch((err) => {
          log(`error attest client attest enclave`, url, err)
          close()
        })
      }

      unpack.on('data', (msg) => {
        const nonceOk = typeof msg?.nonce === 'string'
        if (msg?.type !== 'attest_nonce' || !nonceOk) { return }
        attestEnclave(msg.nonce)
      })

      pack.pipe(encrypt)
      decrypt.pipe(unpack)

      res([pack, unpack, attestData])
    }).catch(rej)
  })
  conn.catch(noop).finally(() => clearTimeout(timer))
  return conn
}

module.exports = {
  timeout, urlToHostAndPath,
  writeStream, endStream,
  sendHello, startState,
  connect, client,
}
