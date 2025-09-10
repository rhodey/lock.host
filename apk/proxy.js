const fs = require('fs')
const fspath = require('path')
const http = require('http')
const http2 = require('node:http2')
const minimist = require('minimist')

function onError(err) {
  console.error('error', err)
  process.exit(1)
}

function on500(err, request, response) {
  console.log('http 500', request.url, err)
  response.writeHead(500)
  response.end()
}

// called with: https://dl-cdn.alpinelinux.org/alpine/v3.18/main
function https(host, method, path) {
  return new Promise((res, rej) => {
    const info = `${host} ${path}`
    const client = http2.connect(`https://${host}`)

    client.once('error', (err) => {
      console.error(`http ${info} error ${err.message}`)
      rej(500)
    })

    const request = client.request({ ':path': path })
    request.once('end', () => client.close())
    request.once('response', (headers) => {
      const status = headers[':status']
      if (status !== 200) {
        console.error(`http ${info} status ${status}`)
        return rej(status)
      }
      res({ status, stream: request })
    })

    request.end()
  })
}

// whole purpose of this file is to fetch apks from alpine and save to apk/ dir
async function proxyAndCopy(request, response) {
  console.log('begin', request.method, request.url)

  try {

    const target = new URL(apkTarget)
    let path = request.url.substr(1)
    path = `${target.pathname}${path}`
    const result = await https(target.host, request.method, path)
    const { status, stream } = result

    path = path.substr(1)
    path = `apk/${path}`
    const dir = fspath.dirname(path)
    fs.mkdirSync(dir, { recursive: true })

    const copy = fs.createWriteStream(path)
    stream.pipe(copy)
    copy.once('close', () => {
      response.writeHead(status)
      const fwd = fs.createReadStream(path)
      fwd.pipe(response)
      fwd.once('close', () => console.log('ok', request.method, request.url))
    })

  } catch (status) {
    response.writeHead(status)
    response.end()
  }
}

const httpServer = http.createServer(function (request, response) {
  proxyAndCopy(request, response).catch((err) => on500(err, request, response))
})

process.once('SIGINT', () => process.exit(0))
process.once('SIGTERM', () => process.exit(0))

const argv = minimist(process.argv.slice(2))
const [port, apkTarget] = argv._

httpServer.on('close', () => onError(new Error('localhost httpServer closed')))
httpServer.listen(parseInt(port))

console.log('ready', port, apkTarget)
