const net = require('net')
const util = require('util')
const split = require('split')
const crypto = require('crypto')
const spawn = require('child_process').spawn
const exec = require('child_process').exec
const dnsServer = require('./dns.js')
const attestServer = require('./attest-server.js')
const getsockopt = require('./sockopt.js')
const openVSock = require('./vsock.js')
const fetch = require('./fetch.js')

const netTimeout = 5_000
const vsockTimeout = 5_000
const isTest = process.env.PROD !== 'true'
const uuid = () => crypto.randomBytes(8).toString('hex')

// todo: heartbeats
// todo: delay before exit for logs

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

function write(stream, data) {
  const isNet = stream instanceof net.Socket
  const timeoutMs = isNet ? netTimeout : vsockTimeout
  const name = isNet ? 'net' : 'vsock'
  const [timer, timedout] = timeout(timeoutMs)
  const write = new Promise((res, rej) => {
    timedout.catch((err) => rej(new Error(`${name} write timeout`)))
    stream.write(data, (err) => {
      if (err) { return rej(err) }
      res()
    })
  })
  write.catch(noop).finally(() => clearTimeout(timer))
  return write
}

function end(stream) {
  const isNet = stream instanceof net.Socket
  const timeoutMs = isNet ? netTimeout : vsockTimeout
  const [timer, timedout] = timeout(timeoutMs)
  const end = () => {
    clearTimeout(timer)
    stream.destroy()
  }
  timedout.catch(end)
  stream.once('error', end)
  stream.once('close', end)
  stream.end()
}

function connectToLocalTcp(port) {
  const info = `local ${port} tcp`
  const conn = new net.Socket()
  const [timer, timedout] = timeout(netTimeout)
  const connect = new Promise((res, rej) => {
    timedout.catch((err) => rej(new Error(`connect ${info} timeout`)))
    conn.on('error', (err) => rej(new Error(`connect ${info} error ${err.message}`)))
    conn.on('connectionAttemptFailed', () => rej(new Error(`connect ${info} failed`)))
    conn.on('connectionAttemptTimeout', () => rej(new Error(`connect ${info} timeout`)))
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

// obj arrive from host
async function onVSockData(obj) {
  let { id, port, data } = obj
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
        write(vsock, { id }).catch((err) => onError(new Error(`write to vsock failed ${err.message}`)))
        end(server)
      }

      server.on('error', cleanup)
      server.on('close', cleanup)

      // fwd data to host to fwd to client outside
      server.on('data', (data) => {
        data = { id, data }
        write(vsock, data).catch((err) => onError(new Error(`write to vsock failed ${err.message}`)))
      })
    }).catch((err) => {
      delete connections[id]
      log('in server conn failed', id, port, err)
      write(vsock, { id }).catch((err) => onError(new Error(`write to vsock failed ${err.message}`)))
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
      end(client)
      return
    }

    // fwd data to client in enclave
    write(client, data).catch((err) => {
      delete connections[id]
      log('write to enclave client conn failed', id, ip, port, err)
      write(vsock, { id }).catch((err) => onError(new Error(`write to vsock failed ${err.message}`)))
      end(client)
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
    end(server)
    return
  }

  // fwd data to server in enclave
  write(server, data).catch((err) => {
    delete connections[id]
    log('write to in server failed', id, port, err)
    write(vsock, { id }).catch((err) => onError(new Error(`write to vsock failed ${err.message}`)))
    end(server)
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
  let data = { id, ip, port }
  await write(vsock, data).catch((err) => onError(new Error(`write to vsock failed ${err.message}`)))
  connections[id] = { ip, port, client }

  const cleanup = () => {
    if (!connections[id]) { return }
    delete connections[id]
    if (ip !== '127.0.0.1') { log('in enclave client closed out conn', id, ip, port) }
    write(vsock, { id }).catch((err) => onError(new Error(`write to vsock failed ${err.message}`)))
    end(client)
  }

  client.on('error', cleanup)
  client.on('close', cleanup)

  // fwd data to host to fwd to out server
  client.on('data', (data) => {
    data = { id, data }
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
  child.on('exit', (code) => onError(new Error(`app exit ${code}`)))
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
  Object.assign(env, process.env)
  const child = spawn(cmd, args, { stdio, env, cwd: '/app' })
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
      const ok = tcpPorts.map((port) => attestServer(port, onError, log))
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

const waitForHost = (vs) => {
  log('open')
  log('wait')
  return new Promise((res, rej) => vs.once('data', () => res(vs)))
}

let args = process.argv.slice(2)
const idx = args.findIndex((a) => isNaN(parseInt(a)))
const tcpPorts = args.slice(0, idx).map((a) => parseInt(a))
args = args.slice(idx)

openVSock(0, onError).then(waitForHost).then((vs) => {
  vsock = vs
  log('connected to host')
  return bootServers().then(() => {
    booted = true
    vsock.on('data', onVSockData)
    return startApp(args)
      .then(() => log('ready'))
  })
}).catch(onError)
