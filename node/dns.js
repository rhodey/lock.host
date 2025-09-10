const dns2 = require('dns2')
const { DOHClient, Packet } = dns2
const ttlCache = require('./cache.js')

const TTL = 10 * 60 * 1000

module.exports = function start(onError, log) {
  const queries = { }
  const dnsClient = DOHClient({ dns: '1.1.1.1' }) // cloudflare
  const cache = new ttlCache(TTL)

  function query(name) {
    return new Promise((res, rej) => {
      const cached = cache.get(name)
      if (cached) {
        res(cached)
        return
      }

      // only one live query per name
      const prev = queries[name]
      if (prev) {
        prev.push({res, rej})
        return
      }

      log('new dns query', name)
      queries[name] = [{res, rej}]

      dnsClient(name).then((info) => {
        if (!Array.isArray(info.answers)) { info.answers = [] }
        info.answers = info.answers.filter((answer) => answer.address)
        cache.set(name, info)
        queries[name].forEach((cbs) => cbs.res(info))
        delete queries[name]
      }).catch((err) => {
        log('dns query error', name, err)
        queries[name].forEach((cbs) => cbs.rej(err))
        delete queries[name]
      })
    })
  }

  const udpServer = dns2.createServer({
    udp: true,
    handle: (request, send, rinfo) => {
    const [ question ] = request.questions
      const { name } = question
      query(name).then((info) => {
        const [ answer ] = info.answers
        const response = Packet.createResponseFromRequest(request)
        if (answer) { response.answers.push(answer) }
        return send(response).catch((err) => log('dns reply error', name, err))
      }).catch((err) => { })
    }
  })

  udpServer.on('error', (err) => onError(new Error(`udpServer error ${err.message}`)))
  udpServer.on('close', () => onError(new Error('udpServer closed')))

  return new Promise((res, rej) => {
    // all dns queries within container/enclave are redirected to here
    udpServer.listen({ udp: { type: 'udp4', address: '127.0.0.1', port: 53 }})
    udpServer.once('listening', res)
  })
}
