const net = require('net')
const http = require('http')
const crypto = require('crypto')
const openVSock = require('./vsock.js')

const netTimeout = 10_000
const vsockTimeout = 5_000
const uuid = () => crypto.randomBytes(8).toString('hex')

function log(...args) {
  args = ['host.js -', ...args]
  console.log.apply(null, args)
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

function connectToRemoteTcp(ip, port) {
  const info = `${ip} ${port} tcp`
  const conn = new net.Socket()
  const [timer, timedout] = timeout(netTimeout)
  const connect = new Promise((res, rej) => {
    conn.on('error', (err) => rej(new Error(`connect ${info} error ${err.message}`)))
    conn.on('connectionAttemptFailed', () => rej(new Error(`connect ${info} failed`)))
    conn.on('connectionAttemptTimeout', () => rej(new Error(`connect ${info} timeout`)))
    timedout.catch((err) => rej(new Error(`connect ${info} timeout`)))
    conn.on('close', () => rej(new Error(`connect ${info} close`)))
    conn.connect(port, ip, () => res(conn))
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

// lines arrive from runtime
async function onVSockData(line) {
  const json = await parseOrError(line)
  if (!json) { return }

  let { id, ip, port, data } = json
  if (!connections[id] && (!ip || !port)) { return }

  // new out connection
  if (!connections[id]) {
    log('new out connection request', id, ip, port)
    connections[id] = { ip, port }
    connections[id].connected = connectToRemoteTcp(ip, port).then((server) => {
      log('connected to out server', id, ip, port)
      connections[id].server = server

      const cleanup = () => {
        if (!connections[id]) { return }
        delete connections[id]
        log('out server closed connection', id, ip, port)
        data = Buffer.from(JSON.stringify({ id }) + "\n")
        write(vsock, data).catch((err) => onError(new Error(`write to vsock failed ${err.message}`)))
        server.destroySoon()
      }

      server.on('error', cleanup)
      server.on('close', cleanup)

      // fwd data to runtime to enclave
      server.on('data', (recv) => {
        recv = recv.toString('base64')
        data = Buffer.from(JSON.stringify({ id, data: recv }) + "\n")
        write(vsock, data).catch((err) => onError(new Error(`write to vsock failed ${err.message}`)))
      })
    }).catch((err) => {
      delete connections[id]
      log('out server connection failed', id, ip, port, err)
      const data = Buffer.from(JSON.stringify({ id }) + "\n")
      write(vsock, data).catch((err) => onError(new Error(`write to vsock failed ${err.message}`)))
    })
    return
  }

  // data from server in enclave
  let conn = connections[id]
  const { client } = conn
  ip = conn.ip
  port = conn.port

  if (client) {
    // runtime says close
    if (!data) {
      delete connections[id]
      log('runtime closed inbound enclave connection', id, ip, port)
      client.destroySoon()
      return
    }

    // fwd data to remote client
    data = Buffer.from(data, 'base64')
    write(client, data).catch((err) => {
      delete connections[id]
      log('write to remote client connection failed', id, ip, port, err)
      data = Buffer.from(JSON.stringify({ id }) + "\n")
      write(vsock, data).catch((err) => onError(new Error(`write to vsock failed ${err.message}`)))
      client.destroySoon()
    })
    return
  }

  // data from enclave for out server
  conn = connections[id]
  await conn.connected
  conn = connections[id]
  if (!conn) { return }

  const { server } = conn
  ip = conn.ip
  port = conn.port

  // runtime says close
  if (!data) {
    delete connections[id]
    log('runtime closed outbound server connection', id, ip, port)
    server.destroySoon()
    return
  }

  // fwd data to out server
  data = Buffer.from(data, 'base64')
  write(server, data).catch((err) => {
    delete connections[id]
    log('write to out server failed', id, ip, port, err)
    data = Buffer.from(JSON.stringify({ id }) + "\n")
    write(vsock, data).catch((err) => onError(new Error(`write to vsock failed ${err.message}`)))
    server.destroySoon()
  })
}

// connections arrive from internet
async function accept(client, port) {
  const { remoteAddress: ip } = client
  const id = uuid()
  log('new in server request', id, ip, port)

  // cause runtime to open connection to localhost:port
  let data = Buffer.from(JSON.stringify({ id, port }) + "\n")
  await write(vsock, data).catch((err) => onError(new Error(`write to vsock failed ${err.message}`)))
  connections[id] = { ip, port, client }

  const cleanup = () => {
    if (!connections[id]) { return }
    delete connections[id]
    log('remote client closed inbound server connection', id, ip, port)
    data = Buffer.from(JSON.stringify({ id }) + "\n")
    write(vsock, data).catch((err) => onError(new Error(`write to vsock failed ${err.message}`)))
    client.destroySoon()
  }

  client.on('error', cleanup)
  client.on('close', cleanup)

  // fwd data to runtime to enclave
  client.on('data', (recv) => {
    recv = recv.toString('base64')
    data = Buffer.from(JSON.stringify({ id, data: recv }) + "\n")
    write(vsock, data).catch((err) => onError(new Error(`write to vsock failed ${err.message}`)))
  })
}

function tcpServer(port) {
  const wrap = (client) => {
    accept(client, port).catch((err) => onError(new Error(`tcpServer ${port} error ${err.message}`)))
  }
  const tcpServer = net.createServer(wrap)
  return new Promise((res, rej) => {
    tcpServer.on('error', (err) => onError(new Error(`tcpServer ${port} error ${err.message}`)))
    tcpServer.on('close', () => onError(new Error(`tcpServer ${port} closed`)))
    tcpServer.listen(port, '0.0.0.0', res)
  })
}

// connections arrive from runtime
function writeHead(response, stat) {
  response.writeHead(stat)
}

function on500(err, request, response) {
  log('http 500', request.url, err)
  writeHead(response, 500)
  response.end('500')
}

function on400(request, response) {
  writeHead(response, 400)
  response.end('400')
}

function readBody(request) {
  const [timer, timedout] = timeout(netTimeout)
  const read = new Promise((res, rej) => {
    timedout.catch((err) => rej(new Error('http read timeout')))
    let str = ``
    request.setEncoding('utf8')
    request.on('error', rej)
    request.on('data', (chunk) => str += chunk)
    request.on('end', () => res(str))
  })
  read.catch(noop).finally(() => clearTimeout(timer))
  return read
}

// used by runtime
async function putLog(request, response) {
  const body = await readBody(request)
  const json = JSON.parse(body)
  const { from, msg } = json

  if (typeof from !== 'string' || from.length <= 0) {
    on400(request, response)
    return
  } else if (typeof msg !== 'string' || msg.length <= 0) {
    on400(request, response)
    return
  }

  console.log(`${from} -`, msg)
  writeHead(response, 200)
  response.end()
}

// used by runtime
async function getEnv(request, response) {
  const env = JSON.stringify(process.env)
  response.writeHead(200)
  response.end(env)
}

// connections arrive from runtime
const httpServer = http.createServer(async function (request, response) {
  const path = request.url.split('?')[0]

  try {

    if (path.startsWith('/host/log')) {
      await putLog(request, response)
    } else if (path.startsWith('/host/env')) {
      await getEnv(request, response)
    } else {
      writeHead(response, 404)
      response.end('404')
      return
    }

  } catch(err) {
    on500(err, request, response)
  }
})

httpServer.keepAliveTimeout = 0
httpServer.requestTimeout = 10 * 1000
httpServer.headersTimeout = 10 * 1000
httpServer.once('close', () => onError(new Error('httpServer closed')))

// start tcp and http
function bootServers(tcpPorts) {
  return new Promise((res, rej) => {
    const tcpServers = tcpPorts.map(tcpServer)
    Promise.all(tcpServers).then(() => {
      log('tcp ready')
      httpServer.listen(9001, '127.0.0.1', () => {
        log('http ready')
        res()
      })
    }).catch(rej)
  })
}

log('boot')
let vsock = null
const cid = parseInt(process.env.cid)
const tcpPorts = process.argv.slice(2).map((a) => parseInt(a))

openVSock(cid, onError).then((sock) => {
  log('open')
  vsock = sock
  return write(vsock, "host\n").then(() => {
    log('connected to runtime')
    return bootServers(tcpPorts).then(() => {
      vsock.on('data', onVSockData)
      log('ready')
    })
  })
}).catch(onError)
