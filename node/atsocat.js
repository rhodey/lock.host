const net = require('net')
const crypto = require('crypto')
const duplex = require('/runtime/attest-duplex.js')
const { endStream } = duplex

// similar to linux socat cmd

function onError(err) {
  console.log('error', err)
  process.exit(1)
}

async function main() {
  console.log(`main`)
  const args = process.argv.slice(2)
  const [listen, url] = [parseInt(args[0]), args[1]]
  const testFn = (PCR2, userData) => Promise.resolve(PCR2)
  const ok = await duplex.connect(url, testFn)
  let [encrypt, decrypt, PCR] = ok
  encrypt.destroy()
  decrypt.destroy()

  let [PCR0, PCR1, PCR2] = PCR
  console.log(`PCR0 ${PCR0}`)
  console.log(`PCR1 ${PCR1}`)
  console.log(`PCR2 ${PCR2}`)

  const total = crypto.createHash('sha256')
    .update(PCR.join(''))
    .digest('hex')
  console.log(`TOTAL ${total}`)

  const tcpServer = net.createServer(async (client) => {
    console.log(`client connected`)
    const ok = await duplex.connect(url, testFn)
    console.log(`server connected`)
    if (PCR.join('') !== ok[2].join('')) { onError(`PCR changed`) }
    [encrypt, decrypt, PCR] = ok

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

    client.on('close', close)
    encrypt.on('close', close)
    decrypt.on('close', close)

    client.pipe(encrypt)
    decrypt.pipe(client)
  })

  tcpServer.on('error', (err) => onError(new Error(`tcpServer error ${err.message}`)))
  tcpServer.on('close', () => onError(new Error('tcpServer closed')))
  tcpServer.listen(listen, '0.0.0.0')
}

main()
  .catch(onError)
