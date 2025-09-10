const fs = require('fs')
const net = require('net')
const split = require('split')
const spawn = require('child_process').spawn

// connect to /dev/vsock via /bin/vsock
// or if running as test then simulate using fifos

function openFifoRead() {
  const path = '/tmp/read'
  const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK
  return new Promise((res, rej) => {
    fs.open(path, flags, (err, fd) => {
      if (err) { return rej(err) }
      const sock = new net.Socket({ fd })
      res(sock.pipe(split()))
    })
  })
}

function openFifoWrite() {
  const path = '/tmp/write'
  return fs.createWriteStream(path)
}

async function openFifos(onError) {
  const read = await openFifoRead()
  read.once('error', (err) => onError(new Error(`fifo read error ${err.message}`)))
  read.once('close', () => onError(new Error(`fifo read closed`)))

  const write = openFifoWrite()
  write.once('error', (err) => onError(new Error(`fifo write error ${err.message}`)))
  write.once('close', () => onError(new Error(`fifo write closed`)))

  return {
    on: function (event, cb) {
      read.on(event, cb)
    },
    once: function (event, cb) {
      read.once(event, cb)
    },
    write: function (data, cb) {
      write.write(data, cb)
    }
  }
}

function wrapPid(child) {
  return new Promise((res, rej) => {
    child.once('error', rej)
    if (child.pid) { res(child) }
    rej(new Error('no child pid'))
  })
}

function wrapErrors(child, onError) {
  child.on('exit', (code) => onError(new Error(`vsock exit ${code}`)))
  child.on('error', (err) => onError(new Error(`vsock error ${err.message}`)))
  child.stdin.on('error', (err) => onError(new Error(`vsock stdin error ${err.message}`)))
  child.stderr.on('error', (err) => onError(new Error(`vsock stderr error ${err.message}`)))
  child.stdout.on('error', (err) => onError(new Error(`vsock stdout error ${err.message}`)))
  child.stdin.once('end', () => onError(new Error('vsock stdin end')))
  child.stderr.once('end', () => onError(new Error('vsock stderr end')))
  child.stdout.once('end', () => onError(new Error('vsock stdout end')))
  return child
}

// rust/src/bin/vsock.rs
function openVSock(cid, onError) {
  const stdio = ['pipe', 'pipe', 'pipe']
  const child = spawn('/bin/vsock', [cid], { stdio, env: { }})
  return wrapPid(child).then((child) => {
    child.stderr.setEncoding('utf8')
    child.stdout.setEncoding('utf8')
    child.stderr.pipe(child.stdout)
    const read = child.stdout.pipe(split())
    child = wrapErrors(child, onError)
    return {
      on: function (event, cb) {
        read.on(event, cb)
      },
      once: function (event, cb) {
        read.once(event, cb)
      },
      write: function (data, cb) {
        child.stdin.write(data, cb)
      }
    }
  })
}

module.exports = function open(cid, onError) {
  const isTest = process.env.PROD !== 'true'
  return isTest ? openFifos(onError) : openVSock(cid, onError)
}
