const fs = require('fs/promises')
const crypto = require('crypto')
const minimist = require('minimist')
const duplex = require('/runtime/attest-duplex.js')
const { FetchHelper } = require('/runtime/dispatch.js')
const sodium = require('libsodium-wrappers')
const Database = require('better-sqlite3')

// all languages allow create child processes
// this program is how lock.host apps can talk to key servers

const netTimeout = 5_000

const defaults = {}
defaults['length'] = '32'
defaults['target-csv'] = '/runtime/target.csv'

function log(...args) {
  console.error.apply(null, args)
}

function onError(err) {
  log('error', err)
  process.exit(1)
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
    timedout.catch((err) => rej(new Error(`write timeout`)))
    stream.write(data, (err) => {
      if (err) { return rej(err) }
      res()
    })
  })
  write.catch(noop).finally(() => clearTimeout(timer))
  return write
}

// session re-use = fast
let db = null
function createSessionDb(reset=false) {
  db = new Database(`/runtime/sessions.db`, {})
  db.pragma('journal_mode = TRUNCATE')
  db.pragma('synchronous = FULL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_sign_keys (
      target TEXT NOT NULL,
      app_id TEXT NOT NULL,
      sign_key TEXT NOT NULL,
      app_version TEXT NOT NULL,
      PRIMARY KEY (target, app_id)
    );`
  )
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_keys (
      target TEXT NOT NULL,
      app_id TEXT NOT NULL,
      cookie TEXT NOT NULL,
      key_tx TEXT NOT NULL,
      key_rx TEXT NOT NULL,
      PRIMARY KEY (target, app_id)
    );`
  )
  reset && db.prepare(`DELETE FROM app_sign_keys`).run()
  reset && db.prepare(`DELETE FROM session_keys`).run()
}

const readFile = async (path) => {
  try {
    return await fs.readFile(path)
  } catch (err) {
    if (err.code === 'ENOENT') { return null }
    throw err
  }
}

const isStrLen = (arg, len1, len2) => {
  if (typeof arg !== 'string') { return false }
  if (!len2) { return arg.length === len1 }
  return arg.length >= len1 && arg.length <= len2
}

function readTargetCsv(targetCsv, target) {
  let csv = targetCsv.toString('utf8')
  csv = csv.split(`\n`).map((line) => line.trim())
  csv = csv.find((line) => line.startsWith(target))
  if (!csv) { throw new Error(`target csv no ${target}`) }
  const [t, url, nitroPcr, amiPcr] = csv.split(`,`)
  if (!url) { throw new Error(`target csv no url`) }
  if (!url.startsWith('https://')) { throw new Error(`target csv no https url`) }
  if (!isStrLen(nitroPcr, 64)) { throw new Error(`target csv nitroPcr not 64`) }
  if (!isStrLen(amiPcr, 64)) { throw new Error(`target csv amiPcr not 64`) }
  return [target, url, nitroPcr, amiPcr]
}

function testFnFn(arr) {
  const [target, u, nitroPcr, amiPcr] = arr
  return async function testFn(PCR2, userData) {
    PCR2 = crypto.createHash('sha256').update(PCR2.join('')).digest('hex')
    if (nitroPcr !== PCR2) { throw new Error(`Nitro PCR does not match (${target})`) }
    userData = userData ? userData.toString('utf8') : ''
    if (amiPcr !== userData) { throw new Error(`AMI PCR does not match (${target})`) }
  }
}

function add2ToPort(url) {
  let [host, path] = duplex.urlToHostAndPath(url)
  host = host.split(':')
  host[2] = parseInt(host[2]) + 2
  host = host.join(':')
  return host + path
}

async function getSignKey(target, url, testFn, appId, attestSecret) {
  const row = db.prepare('SELECT * FROM app_sign_keys WHERE target = ? AND app_id = ?').get(target, appId)
  if (row) {
    log(`db has sign_key`)
    return [row.sign_key, row.app_version]
  }

  url = add2ToPort(url)
  log(url)
  const userData = Buffer.from(appId)
  const txrx = await duplex.client(url, testFn, log, userData)

  log(`connected`)
  const [tx, rx] = txrx

  const ask = new Promise((res, rej) => {
    const close = (err) => {
      log(`conn close`)
      rej(err)
    }

    tx.on('error', close)
    rx.on('error', close)
    tx.on('close', () => close('close'))
    rx.on('close', () => close('close'))

    const getAppSignKey = () => {
      log(`ask signing key`)
      write(tx, { type: 'get_app_v_sign_key', attestSecret })
        .catch((err) => rej(`error write get_app_v_sign_key - ${err.message}`))
    }

    const getAppSignKeyAck = (signKey, appVersion) => {
      if (signKey === null) { return rej('server says attest secret is not correct') }
      if (!isStrLen(appVersion, 32)) { return rej('get_app_v_sign_key_ack version not 32') }
      if (!isStrLen(signKey, 64, 128)) { return rej('get_app_v_sign_key_ack key not >= 64 <= 128') }
      signKey = Buffer.from(signKey, 'base64')
      if (signKey.length !== 64) { return rej('get_app_v_sign_key_ack key not 64') }
      log(`have signing key`)
      db.prepare(`INSERT INTO app_sign_keys (target, app_id, sign_key, app_version) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`)
        .run(target, appId, signKey, appVersion)
      res([signKey, appVersion])
    }

    const timer1 = setTimeout(() => rej('duplex_ready timeout'), netTimeout)
    const timer2 = setTimeout(() => rej('get_app_v_sign_key_ack timeout'), netTimeout * 2)

    rx.on('data', (msg) => {
      const isReady = msg?.type === 'duplex_ready'
      const isGetSignKeyAck = msg?.type === 'get_app_v_sign_key_ack'
      const isError = msg?.type === 'error'
      if (isReady) {
        clearTimeout(timer1)
        getAppSignKey()
      } else if (isGetSignKeyAck) {
        clearTimeout(timer2)
        getAppSignKeyAck(msg.signKey, msg.appVersion)
      } else if (isError) {
        log('server sent error', msg.error)
        rej(msg.error)
      }
    })
  })

  ask.catch(noop).finally(() => {
    tx.end()
    rx.end()
  })

  return ask
}

async function main() {
  log(`main`)
  await sodium.ready
  let args = minimist(process.argv.slice(2))
  args = Object.assign(defaults, args)
  createSessionDb(args.reset)

  const { target } = args
  let targetCsv = args['target-csv']
  targetCsv = await readFile(targetCsv)
  if (!isStrLen(target, 1, 128)) {
    onError('--target is needed')
  } else if (targetCsv === null) {
    onError(`${args['target-csv']} is empty`)
  }

  const arr = readTargetCsv(targetCsv, target)
  const testFn = testFnFn(arr)
  const [t, url] = arr

  const cmds = ['get-app-key', 'gen-app-key', 'set-app-key', 'rm-app-key']
  const cmd = cmds.find((cmd) => args[cmd] !== undefined)
  const nameArg = args[cmd]

  if (!cmd) {
    onError('cmd is needed')
  } else if (!isStrLen(nameArg, 1, 128)) {
    onError(`--${cmd} needs name 1 to 128 chars`)
  }

  const appId = args['app-id']
  if (!isStrLen(appId, 32)) {
    onError('--app-id needs length 32')
  }

  log(`target ${target}`)
  log(`app ID ${appId}`)
  log(`command ${cmd}`)
  log(`name arg ${nameArg}`)

  const attestSecret = process.env.ATTEST_SECRET
  if (!isStrLen(attestSecret, 64)) {
    onError('env ATTEST_SECRET needs length 64')
  }

  let { length } = args
  length = parseInt(length)
  if (isNaN(length)) {
    onError('--length needs num (bytes)')
  } else if (length < 16) {
    onError('--length min 16 (bytes)')
  } else if (length > 128) {
    onError('--length max 128 (bytes)')
  }

  let { key } = args
  key = key ? Buffer.from(key, 'base64') : null
  if (cmd.startsWith('set') && !key) {
    onError('--set-app-key needs --key')
  } else if (key && key.length < 16) {
    onError('--key min length 16 (bytes)')
  } else if (key && key.length > 128) {
    onError('--key max length 128 (bytes)')
  } else if (key) {
    key = key.toString('base64')
  }

  cmd.startsWith('gen') && log(`key length ${length}`)
  cmd.startsWith('set') && log(`key length ${key.length}`)

  const lock = args.lock === true
  cmd.startsWith('gen') && log(`lock ${lock}`)
  cmd.startsWith('set') && log(`lock ${lock}`)

  const replace = args.replace === true
  cmd.startsWith('gen') && log(`replace ${replace}`)
  cmd.startsWith('set') && log(`replace ${replace}`)

  const [signKey, appVersion] = await getSignKey(target, url, testFn, appId, attestSecret)

  const sessions = {
    get: () => {
      const row = db.prepare('SELECT * FROM session_keys WHERE target = ? AND app_id = ?').get(target, appId)
      if (!row) { return null }
      row.key_tx = Buffer.from(row.key_tx, 'base64')
      row.key_rx = Buffer.from(row.key_rx, 'base64')
      log(`db has session keys`)
      return [row.cookie, row.key_tx, row.key_rx]
    },
    set: (state) => {
      let [cookie, key_tx, key_rx] = state
      key_tx = Buffer.from(key_tx).toString('base64')
      key_rx = Buffer.from(key_rx).toString('base64')
      db.prepare(`DELETE FROM session_keys WHERE target = ? AND app_id = ?`).run(target, appId)
      db.prepare(`INSERT INTO session_keys (target, app_id, cookie, key_tx, key_rx) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
        .run(target, appId, cookie, key_tx, key_rx)
    }
  }

  const [h, path] = duplex.urlToHostAndPath(url)
  const dispatcher = new FetchHelper(testFn, path, sessions)

  const signAndFetch = (url, query, body) => {
    query = query ? new URLSearchParams(query).toString() : null
    body = body ? JSON.stringify(body) : null
    const plain = query ? Buffer.from(query) : Buffer.from(body)
    let sig = sodium.crypto_sign_detached(plain, signKey)
    sig = Buffer.from(sig).toString('base64')
    const headers = {}
    headers['x-app-version'] = appVersion
    headers['x-app-signature'] = sig
    let next = null
    if (query) {
      url = `${url}?${query}`
      next = fetch(url, { dispatcher, method: 'GET', headers })
    } else {
      next = fetch(url, { dispatcher, method: 'POST', headers, body: plain })
    }
    return next.then((res) => {
      if (!res.ok) { throw new Error(`status ${res.status}`) }
      return res
    }).then((ok) => {
      return ok.json().catch((err) => { throw new Error(`not json`) })
    })
  }

  const getAppKey = async (name) => {
    const api = `${url}/get-app-key`
    const query = { name }
    log(api)
    const json = await signAndFetch(api, null, query)
    console.log(JSON.stringify(json))
    process.exit(0)
  }

  const genAppKey = async (name, length, replace) => {
    const api = `${url}/gen-app-key`
    const query = { name, length, lock, replace }
    log(api)
    const json = await signAndFetch(api, null, query)
    console.log(JSON.stringify(json))
    process.exit(0)
  }

  const setAppKey = async (name, key, replace) => {
    const api = `${url}/set-app-key`
    const query = { name, data: key, lock, replace }
    log(api)
    const json = await signAndFetch(api, null, query)
    console.log(JSON.stringify(json))
    process.exit(0)
  }

  const rmAppKey = async (name) => {
    const api = `${url}/rm-app-key`
    const query = { name }
    log(api)
    const json = await signAndFetch(api, null, query)
    console.log(JSON.stringify(json))
    process.exit(0)
  }

  if (cmd.startsWith('get')) {
    getAppKey(nameArg).catch(onError)
  } else if (cmd.startsWith('gen')) {
    genAppKey(nameArg, length, replace).catch(onError)
  } else if (cmd.startsWith('set')) {
    setAppKey(nameArg, key, replace).catch(onError)
  } else if (cmd.startsWith('rm')) {
    rmAppKey(nameArg).catch(onError)
  }
}

main()
  .catch(onError)
