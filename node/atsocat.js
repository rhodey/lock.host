const net = require('net')
const crypto = require('crypto')
const duplex = require('/runtime/attest-duplex.js')
const { endStream } = duplex
const minimist = require('minimist')

// similar to linux socat cmd

function onError(err) {
  console.log('error', err)
  process.exit(1)
}

async function main() {
  console.log(`main`)
  const args = minimist(process.argv.slice(2))
  const [listen, url] = [parseInt(args._[0]), args._[1]]

  const testFn = async (PCR2, userData) => {
    const total = crypto.createHash('sha256').update(PCR2.join('')).digest('hex')
    if (args.total === undefined) { return [PCR2, total] }
    if (args.total !== total) { throw new Error(`PCRs do not match (${args.total}) (${total})`) }
    return [PCR2, total]
  }

  const ok = await duplex.connect(url, testFn)
  let [encrypt, decrypt, attestData] = ok
  let [PCR, total] = attestData
  encrypt.destroy()
  decrypt.destroy()

  let [PCR0, PCR1, PCR2] = PCR
  console.log(`PCR0 ${PCR0}`)
  console.log(`PCR1 ${PCR1}`)
  console.log(`PCR2 ${PCR2}`)
  console.log(`TOTAL ${total}`)

  const tcpServer = net.createServer(async (client) => {
    console.log(`client connected`)
    const ok = await duplex.connect(url, testFn)
    console.log(`server connected`)
    if (PCR.join('') !== ok[2][0].join('')) { onError(`PCR changed`) }
    [encrypt, decrypt, attestData] = ok

    const close = (err='') => {
      err = typeof err === 'boolean' ? '' : err
      console.log(`close`, err)
      endStream(encrypt)
      endStream(decrypt)
      endStream(client)
    }

    client.on('error', close)
    encrypt.on('error', close)
    decrypt.on('error', close)

    client.once('close', close)
    encrypt.once('close', close)
    decrypt.once('close', close)

    client.pipe(encrypt)
    decrypt.pipe(client)
  })

  tcpServer.on('error', (err) => onError(new Error(`tcpServer error ${err.message}`)))
  tcpServer.once('close', () => onError(new Error('tcpServer closed')))
  tcpServer.listen(listen, '0.0.0.0')
}

main()
  .catch(onError)
