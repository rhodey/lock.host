const net = require('net')
const util = require('util')
const split = require('split')
const crypto = require('crypto')
const spawn = require('child_process').spawn
const exec = require('child_process').exec
const dnsServer = require('./dns.js')
const attestHttp = require('./attest-http.js')
const getsockopt = require('./sockopt.js')
const openVSock = require('./vsock.js')
const fetch = require('./fetch.js')

const netTimeout = 5_000
const vsockTimeout = 5_000
const isTest = process.env.PROD !== 'true'
const uuid = () => crypto.randomBytes(8).toString('hex')

function sendLog(from, msg) {
  const host = 'http://127.0.0.1:9000'
  const body = JSON.stringify({ from, msg })
  const request = new Request(`${host}/host/log`, { method: 'POST', body })
  return fetch(request, netTimeout)
}

let booted = false
function log(...args) {
  let from = 'runtime.js'
  if (args[0] === 'app') {
    from = 'app'
    args = args.slice(1)
  }
  console.log.apply(null, [`${from} -`, ...args])
  if (!booted) { return }
  const msg = util.format.apply(null, args)
  sendLog(from, msg)
    .catch((err) => onError(new Error(`log failed with error ${err.message}`)))
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

// write to vsock or tcp socket
function write(sock, data) {
  const isNet = sock instanceof net.Socket
  const timeoutMs = isNet ? netTimeout : vsockTimeout
  const name = isNet ? 'net' : 'vsock'
  const [timer, timedout] = timeout(timeoutMs)
  const write = new Promise((res, rej) => {
    timedout.catch((err) => rej(new Error(`${name} write timeout`)))
    sock.write(data, (err) => {
      if (err) { return rej(err) }
      res()
    })
  })
  write.catch(noop).finally(() => clearTimeout(timer))
  return write
}

function connectToLocalTcp(port) {
  const info = `local ${port} tcp`
  const conn = new net.Socket()
  const [timer, timedout] = timeout(netTimeout)
  const connect = new Promise((res, rej) => {
    conn.on('error', (err) => rej(new Error(`connect ${info} error ${err.message}`)))
    conn.on('connectionAttemptFailed', () => rej(new Error(`connect ${info} failed`)))
    conn.on('connectionAttemptTimeout', () => rej(new Error(`connect ${info} timeout`)))
    timedout.catch((err) => rej(new Error(`connect ${info} timeout`)))
    conn.on('close', () => rej(new Error(`connect ${info} close`)))
    conn.connect(port, '127.0.0.1', () => res(conn))
  }).catch((err) => {
    conn.destroy()
    throw err
  })
  connect.catch(noop).finally(() => clearTimeout(timer))
  return connect
}

const connections = {}

async function parseOrError(line) {
  if (!line) { return }
  try {
    return JSON.parse(line)
  } catch (err) {
    onError(new Error(`error vsock parse ${line}`))
  }
}

// lines arrive from host
async function onVSockData(line) {
  const json = await parseOrError(line)
  if (!json) { return }

  let { id, port, data } = json
  if (!connections[id] && !port) { return }

  // host wants connection into enclave
  if (!connections[id]) {
    const ok = tcpPorts.includes(port)
    if (!ok) { return }
    log('new in server request', id, port)
    connections[id] = { port }
    connections[id].connected = connectToLocalTcp(port).then((server) => {
      log('connected to in server', id, port)
      connections[id].server = server

      const cleanup = () => {
        if (!connections[id]) { return }
        delete connections[id]
        log('in server closed conn', id, port)
        data = Buffer.from(JSON.stringify({ id }) + "\n")
        write(vsock, data).catch((err) => onError(new Error(`write to vsock failed ${err.message}`)))
        server.destroySoon()
      }

      server.on('error', cleanup)
      server.on('close', cleanup)

      // fwd data to host to fwd to client outside
      server.on('data', (recv) => {
        recv = recv.toString('base64')
        data = Buffer.from(JSON.stringify({ id, data: recv }) + "\n")
        write(vsock, data).catch((err) => onError(new Error(`write to vsock failed ${err.message}`)))
      })
    }).catch((err) => {
      delete connections[id]
      log('in server conn failed', id, port, err)
      const data = Buffer.from(JSON.stringify({ id }) + "\n")
      write(vsock, data).catch((err) => onError(new Error(`write to vsock failed ${err.message}`)))
    })
    return
  }

  // data from host for client inside enclave
  let conn = connections[id]
  ip = conn.ip
  port = conn.port
  const { client } = conn

  if (client) {
    // host says close
    if (!data) {
      delete connections[id]
      if (ip !== '127.0.0.1') { log('host closed enclave client conn', id, ip, port) }
      client.destroySoon()
      return
    }

    // fwd data to client in enclave
    data = Buffer.from(data, 'base64')
    write(client, data).catch((err) => {
      delete connections[id]
      log('write to enclave client conn failed', id, ip, port, err)
      data = Buffer.from(JSON.stringify({ id }) + "\n")
      write(vsock, data).catch((err) => onError(new Error(`write to vsock failed ${err.message}`)))
      client.destroySoon()
    })
    return
  }

  // data for server in enclave
  await conn.connected
  conn = connections[id]
  if (!conn) { return }
  const { server } = conn
  port = conn.port

  // host says close
  if (!data) {
    delete connections[id]
    log('host closed in server conn', id, port)
    server.destroySoon()
    return
  }

  // fwd data to server in enclave
  data = Buffer.from(data, 'base64')
  write(server, data).catch((err) => {
    delete connections[id]
    log('write to in server failed', id, port, err)
    data = Buffer.from(JSON.stringify({ id }) + "\n")
    write(vsock, data).catch((err) => onError(new Error(`write to vsock failed ${err.message}`)))
    server.destroySoon()
  })
}

// all tcp connections within enclave are redirected to here
const tcpServer = net.createServer(async (client) => {
  let opts = { ip: '127.0.0.1' }
  try {
    opts = getsockopt(client)
  } catch (err) {
    log('getsockopt error', err)
  }

  // fwd to host http server
  if (opts.ip === '127.0.0.1') { opts.port = 9001 }

  const id = uuid()
  const { ip, port } = opts
  if (ip !== '127.0.0.1') {
    log('new enclave outbound conn', id, ip, port)
  }

  // cause host to open out connection to ip:port
  let data = Buffer.from(JSON.stringify({ id, ip, port }) + "\n")
  await write(vsock, data).catch((err) => onError(new Error(`write to vsock failed ${err.message}`)))
  connections[id] = { ip, port, client }

  const cleanup = () => {
    if (!connections[id]) { return }
    delete connections[id]
    if (ip !== '127.0.0.1') { log('in enclave client closed out conn', id, ip, port) }
    data = Buffer.from(JSON.stringify({ id }) + "\n")
    write(vsock, data).catch((err) => onError(new Error(`write to vsock failed ${err.message}`)))
    client.destroySoon()
  }

  client.on('error', cleanup)
  client.on('close', cleanup)

  // fwd data to host to fwd to out server
  client.on('data', (recv) => {
    recv = recv.toString('base64')
    data = Buffer.from(JSON.stringify({ id, data: recv }) + "\n")
    write(vsock, data).catch((err) => onError(new Error(`write to vsock failed ${err.message}`)))
  })
})

tcpServer.on('error', (err) => onError(new Error(`tcpServer error ${err.message}`)))
tcpServer.on('close', () => onError(new Error('tcpServer closed')))

function wrapPid(child) {
  return new Promise((res, rej) => {
    child.once('error', rej)
    if (child.pid) { res(child) }
    rej(new Error('no child pid'))
  })
}

// exit on app exit
function wrapErrors(child) {
  child.on('error', (err) => onError(new Error(`app error ${err.message}`)))
  child.stderr.on('error', (err) => onError(new Error(`app stderr error ${err.message}`)))
  child.stdout.on('error', (err) => onError(new Error(`app stdout error ${err.message}`)))
  child.stderr.once('end', () => onError(new Error('app stderr end')))
  child.stdout.once('end', () => onError(new Error('app stdout end')))
  return child
}

// start app
async function startApp(args) {
  const cmd = args[0]
  args = args.slice(1)
  const stdio = ['pipe', 'pipe', 'pipe']
  const host = 'http://127.0.0.1:9000'
  const env = await fetch(`${host}/host/env`, netTimeout).then((res) => res.json())
  const child = spawn(cmd, args, { stdio, env: { PROD: process.env.PROD, ...env }, cwd: '/app' })
  return wrapPid(child).then((child) => {
    const appLog = (line) => {
      if (!line) { return }
      log('app', line)
    }
    child.stderr.setEncoding('utf8')
    child.stdout.setEncoding('utf8')
    child.stderr.pipe(split()).on('data', appLog)
    child.stdout.pipe(split()).on('data', appLog)
    return wrapErrors(child)
  })
}

// start tcp and dns
function bootServers() {
  return new Promise((res, rej) => {
    tcpServer.listen(9000, '127.0.0.1', () => {
      const ok = tcpPorts.map((port) => attestHttp(port, onError, log))
      return Promise.all(ok).then(() => {
        log('tcp ready')
        return dnsServer(onError, log)
          .then(() => log('udp ready'))
      }).then(res).catch(rej)
    })
  })
}

log('boot')
let vsock = null

const waitForHost = (sock) => {
  log('open')
  log('wait')
  return new Promise((res, rej) => sock.on('data', () => res(sock)))
}

let args = process.argv.slice(2)
const idx = args.findIndex((a) => isNaN(parseInt(a)))
const tcpPorts = args.slice(0, idx).map((a) => parseInt(a))
args = args.slice(idx)

openVSock(0, onError).then(waitForHost).then((sock) => {
  vsock = sock
  log('connected to host')
  return bootServers().then(() => {
    booted = true
    vsock.on('data', onVSockData)
    return startApp(args)
      .then(() => log('ready'))
  })
}).catch(onError)
