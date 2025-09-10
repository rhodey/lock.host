const net = require('net')
const http2 = require('http2')
const crypto = require('crypto')
const sodium = require('libsodium-wrappers')
const { EncryptStream, DecryptStream } = require('./streams.js')
const attestParse = require('./attest-parse.js')
const cookies = require('cookie')

const netTimeout = 5_000

function onError(err) {
  console.log('error', err)
  process.exit(1)
}

async function sendHello(target, nonce) {
  const keys = sodium.crypto_kx_keypair()
  const publicKey = Buffer.from(keys.publicKey).toString('base64')
  const params = new URLSearchParams({ publicKey, nonce, envelope: 'tcp' })

  return new Promise((res, rej) => {
    const conn = http2.connect(target, { rejectUnauthorized: false })
    const req = conn.request({ ':path': `/lockhost/hello?${params.toString()}` })

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
      body = Buffer.concat(body).toString('utf8')
      try {
        body = JSON.parse(body)
        res({ status, cookie, body, keys })
      } catch (err) {
        rej(new Error('hello = reply not json'))
      }
      conn.close()
    })
    req.end()
  })
}

async function startState(hello, nonce) {
  const { status, cookie, body, keys } = hello
  if (status !== 200) {
    throw new Error(`hello = status ${status}`)
  } else if (!cookie) {
    throw new Error(`hello = no cookie`)
  }

  let { attestDoc } = body
  attestDoc = Buffer.from(attestDoc, 'base64')
  const ok = await attestParse(attestDoc)
  const { publicKey, nonce: nonce2, PCR } = ok

  if (nonce !== nonce2.toString('base64')) {
    throw new Error('hello = attest doc nonce not ok')
  }

  try {
    const sessionKeys = sodium.crypto_kx_client_session_keys(
      keys.publicKey, keys.privateKey,
      publicKey
    )
    return { cookie, sessionKeys, PCR }
  } catch (err) {
    throw new Error('hello = attest doc key not ok')
  }
}

const noop = () => {}

function timeout(ms) {
  let timer = null
  const timedout = new Promise((res, rej) => {
    timer = setTimeout(() => rej(null), ms)
  })
  return [timer, timedout]
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

async function main() {
  await sodium.ready
  console.log(`boot`)

  const args = process.argv.slice(2)
  const port = parseInt(args[0])
  let target = args[1]
  target = `https://${target}:${args[2]}`

  const nonce = crypto.randomBytes(32).toString('base64')
  const hello = await sendHello(target, nonce)
  const state = await startState(hello, nonce)

  let { PCR } = state
  let [PCR0, PCR1, PCR2] = PCR
  console.log(`PCR0 ${PCR0}`)
  console.log(`PCR1 ${PCR1}`)
  console.log(`PCR2 ${PCR2}`)

  const tcpServer = net.createServer(async (client) => {
    console.log(`client connect`)
    // session may have expired
    const nonce = crypto.randomBytes(32).toString('base64')
    const hello = await sendHello(target, nonce)
    const state = await startState(hello, nonce)
    const { cookie, sessionKeys: keys } = state
    if (PCR.join(',') !== state.PCR.join(',')) {
      console.log(`PCR changed`)
      [PCR0, PCR1, PCR2] = state.PCR
      console.log(`PCR0 ${PCR0}`)
      console.log(`PCR1 ${PCR1}`)
      console.log(`PCR2 ${PCR2}`)
      process.exit(1)
      return
    }

    const conn = http2.connect(target, { rejectUnauthorized: false })
    const req = conn.request({
      ':method': 'POST',
      ':path': `/lockhost/session`,
      'cookie': `sessionlh=${cookie}`
    })

    const cleanup = () => {
      client.destroySoon()
      req.end()
    }

    client.on('error', cleanup)
    client.on('close', cleanup)
    req.on('end', cleanup)

    req.on('response', (headers) => {
      const status = headers[':status']
      console.log(`server connect ${status}`)

      const encrypt = new EncryptStream(sodium, keys.sharedTx)
      const decrypt = new DecryptStream(sodium, keys.sharedRx)

      encrypt.on('error', cleanup)
      decrypt.on('error', cleanup)

      const writeOrClose = (stream, data) => {
        write(stream, data)
          .catch(cleanup)
      }

      client.pipe(encrypt).on('data', (data) => writeOrClose(req, data))
      req.pipe(decrypt).on('data', (data) => writeOrClose(client, data))
    })
  })

  tcpServer.on('error', (err) => onError(new Error(`tcpServer error ${err.message}`)))
  tcpServer.on('close', () => onError(new Error('tcpServer closed')))
  tcpServer.listen(port, '0.0.0.0')
}

main()
  .catch(onError)
