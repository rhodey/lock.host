const fs = require('fs')
const net = require('net')
const http2 = require('http2')
const crypto = require('crypto')
const sodium = require('libsodium-wrappers')
const { createCA, createCert } = require('mkcert')
const cookie = require('cookie')
const attest = require('./attest.js')
const ttlCache = require('./cache.js')
const { timeout, endStream } = require('./attest-duplex.js')
const { EncryptStream, DecryptStream } = require('./streams.js')

const netTimeout = 5 * 1000
const sessionCache = 5 * 60 * 1000
const cookieSeconds = 365 * 24 * 60 * 1000

const noop = () => {}
const uuid = () => crypto.randomUUID()

function writeHead(stream, stat, headers={}) {
  headers['access-control-max-age'] = 9999999
  headers['access-control-allow-origin'] = '*'
  headers['access-control-allow-methods'] = 'OPTIONS, POST, GET'
  headers['content-type'] = stat !== 200 ? 'text/plain' : 'application/json'
  stream.respond({ ':status': stat, ...headers })
}

function on500(stream) {
  writeHead(stream, 500)
  stream.end('500')
}

function on400(stream) {
  writeHead(stream, 400)
  stream.end('400')
}

function paramsOfPath(path) {
  const query = path.split('?')[1]
  try {
    return Object.fromEntries(new URLSearchParams(query))
  } catch (err) {
    return {}
  }
}

async function onHello(stream, cache, port, log) {
  const params = paramsOfPath(stream.path)
  let { publicKey, nonce, envelope } = params
  if (!publicKey) { return on400(stream) }
  if (!nonce) { return on400(stream) }
  if (envelope !== 'json' && envelope !== 'tcp') { return on400(stream) }
  publicKey = Buffer.from(publicKey, 'base64')
  nonce = Buffer.from(nonce, 'base64')
  if (nonce.length !== 32) { return on400(stream) }

  const server = sodium.crypto_kx_keypair()
  let attestDoc = await attest(Buffer.from(server.publicKey), nonce, null, port)
  attestDoc = attestDoc.toString('base64')
  const sessionKeys = sodium.crypto_kx_server_session_keys(
    server.publicKey, server.privateKey,
    publicKey
  )

  const sessionId = uuid()
  cache.set(sessionId, { envelope, sessionKeys })

  const cookie = `sessionlh=${sessionId}; max-age=${cookieSeconds}; path=/;`
  const headers = { 'set-cookie': cookie }
  writeHead(stream, 200, headers)
  stream.end(JSON.stringify({ attestDoc, sessionId }))
}

function readBody(stream) {
  const [timer, timedout] = timeout(netTimeout)
  const read = new Promise((res, rej) => {
    timedout.catch((err) => rej(new Error('http2 read timeout')))
    let body = ``
    stream.setEncoding('utf8')
    stream.on('error', rej)
    stream.on('data', (chunk) => body += chunk)
    stream.once('end', () => res(body))
  })
  read.catch(noop).finally(() => clearTimeout(timer))
  return read
}

async function onJsonEnvelope(keys, stream, target, alive) {
  let body = null
  try {
    body = await readBody(stream)
    body = JSON.parse(body)
  } catch (err) {
    on400(stream)
    return
  }

  let key = keys.sharedRx
  body.nonce = Buffer.from(body.nonce, 'base64')
  body.encrypted = Buffer.from(body.encrypted, 'base64')
  body = sodium.crypto_secretbox_open_easy(body.encrypted, body.nonce, key)
  body = Buffer.from(body)
  body = JSON.parse(body.toString('utf8'))

  // keep keys in cache
  alive()

  let headers = new Headers()
  Object.keys(body.headers).forEach((key) => {
    const value = body.headers[key]
    if (!Array.isArray(value)) {
      headers.append(key, value)
    } else {
      value.forEach((val) => headers.append(key, val))
    }
  })

  let { path, method } = body
  body = body.body ? Buffer.from(body.body, 'base64') : undefined
  headers.delete('content-length')
  const url = `http://127.0.0.1:${target}${path}`
  const response = await fetch(url, { method, headers, body })

  headers = {}
  for (const [key, value] of response.headers) {
    if (Array.isArray(headers[key])) {
      headers[key].push(value)
    } else if (headers[key]) {
      headers[key] = [headers[key], value]
    } else {
      headers[key] = value
    }
  }

  delete headers['connection']
  delete headers['keep-alive']
  delete headers['transfer-encoding']

  body = await response.arrayBuffer()
  body = Buffer.from(body).toString('base64')
  let data = { status: response.status, headers, body }
  data = JSON.stringify(data)
  data = Buffer.from(data)

  key = keys.sharedTx
  let nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
  let encrypted = sodium.crypto_secretbox_easy(data, nonce, key)
  nonce = Buffer.from(nonce).toString('base64')
  encrypted = Buffer.from(encrypted).toString('base64')

  writeHead(stream, 200)
  stream.end(JSON.stringify({ nonce, encrypted }))
}

function connectToTcp(port) {
  const info = `local ${port} tcp`
  const conn = new net.Socket()
  const [timer, timedout] = timeout(netTimeout)
  const connect = new Promise((res, rej) => {
    timedout.catch((err) => rej(new Error(`connect to ${info} timeout`)))
    conn.on('error', (err) => rej(new Error(`connect to ${info} error ${err.message}`)))
    conn.once('connectionAttemptFailed', () => rej(new Error(`connect ${info} failed`)))
    conn.once('connectionAttemptTimeout', () => rej(new Error(`connect to ${info} timeout`)))
    conn.once('close', () => rej(new Error(`connect to ${info} close`)))
    conn.connect(port, '127.0.0.1', () => res(conn))
  }).catch((err) => {
    conn.destroy()
    throw err
  })
  connect.catch(noop).finally(() => clearTimeout(timer))
  return connect
}

function write(stream, data) {
  const [timer, timedout] = timeout(netTimeout)
  const write = new Promise((res, rej) => {
    timedout.catch((err) => rej(new Error(`net write timeout`)))
    stream.write(data, (err) => {
      if (err) { return rej(err) }
      res()
    })
  })
  write.catch(noop).finally(() => clearTimeout(timer))
  return write
}

async function onTcpEnvelope(keys, client, target, alive) {
  const server = await connectToTcp(target)
  writeHead(client, 200)

  const cleanup = () => {
    endStream(server)
    endStream(client)
  }

  server.on('error', cleanup)
  client.on('error', cleanup)
  server.once('close', cleanup)
  client.once('close', cleanup)

  const encrypt = new EncryptStream(keys.sharedTx)
  const decrypt = new DecryptStream(keys.sharedRx)

  encrypt.on('error', cleanup)
  decrypt.on('error', cleanup)

  const writeOrClose = (stream, data) => {
    write(stream, data)
      .then(alive) // keep keys in cache
      .catch(cleanup)
  }

  server.pipe(encrypt).on('data', (data) => writeOrClose(client, data))
  client.pipe(decrypt).on('data', (data) => writeOrClose(server, data))
}

async function onSession(stream, cache, target, log) {
  const params = paramsOfPath(stream.path)
  let { sid } = params
  sid = sid ?? stream.cookies.sessionlh
  if (!sid) { return on400(stream) }

  const session = cache.get(sid)
  if (!session) {
    writeHead(stream, 404)
    stream.end('404')
    return
  }

  // keep keys in cache
  const alive = () => cache.set(sid, session)
  const { envelope, sessionKeys } = session

  if (envelope === 'json') {
    await onJsonEnvelope(sessionKeys, stream, target, alive)
  } else {
    await onTcpEnvelope(sessionKeys, stream, target, alive)
  }
}

module.exports = async function attestServer(port, onError, log) {
  const target = 1 + port
  const cache = new ttlCache(sessionCache)

  let [key, cert] = [null, null]

  // http2 requires https
  try {
    key = fs.readFileSync('/runtime/cert.key')
    cert = fs.readFileSync('/runtime/cert.crt')
    log('fs cert')
  } catch (err) {
    log('rand cert')
    const ca = await createCA({
      organization: 'Lock.host',
      countryCode: 'US',
      state: 'New York',
      locality: 'NYC',
      validity: 365
    })
    cert = await createCert({
      ca: { key: ca.key, cert: ca.cert },
      domains: ['127.0.0.1', 'localhost'],
      validity: 3650
    })
    key = cert.key
    cert = cert.cert
  }

  // http2 requires https
  const server = http2.createSecureServer({ key, cert })

  server.on('stream', async (stream, headers) => {
    const path = headers[':path']
    const method = headers[':method']

    // cors
    if (method === 'OPTIONS') {
      writeHead(stream, 204)
      stream.end()
      return
    }

    const cookies = headers['cookie'] || ''
    stream.cookies = cookie.parse(cookies)
    stream.path = path

    const prefix = process.env.LH_SESSION_PATH ?? '/.well-known/lockhost'

    try {

      if (path.startsWith(`${prefix}/hello`)) {
        await onHello(stream, cache, port, log)
      } else if (path.startsWith(`${prefix}/session`)) {
        await onSession(stream, cache, target, log)
      } else if (path.startsWith(`${prefix}/cert`)) {
        writeHead(stream, 200)
        stream.end('accept self-signed')
      } else {
        on400(stream)
      }

    } catch(err) {
      log('http2 server 500', path, err)
      try {
        on500(stream)
      } catch (err) { }
    }
  })

  server.on('error', () => onError(new Error('http2 server error')))
  server.once('close', () => onError(new Error('http2 server close')))

  return new Promise((res, rej) => {
    sodium.ready
      .then(() => server.listen(port, '127.0.0.1', res))
      .catch(rej)
  })
}
