const exec = require('child_process').exec

const timeout = 5_000

module.exports = function attestParse(doc, rootPemPath='/runtime/root.pem') {
  doc = doc.toString('base64')
  const bin = '/bin/attest-parse'
  const cmd = `${bin} ${doc} ${rootPemPath}`
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`parse doc timeout`)), timeout)
    exec(cmd, (error, stdout, stderr) => {
      clearTimeout(timer)
      if (error) { return rej(new Error(`attest-parse error ${error.code} ${stderr}`)) }
      const doc = stdout.trim()
      let [publicKey, nonce, userData, ...PCR] = doc.split(',')
      publicKey = Buffer.from(publicKey, 'base64')
      nonce = Buffer.from(nonce, 'base64')
      userData = Buffer.from(userData, 'base64')
      res({ publicKey, nonce, userData, PCR })
    })
  })
}
