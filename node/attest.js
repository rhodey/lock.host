const exec = require('child_process').exec

const PROD = process.env.PROD

module.exports = function getDoc(publicKey=null, nonce=null, userData=null) {
  publicKey && (publicKey = publicKey.toString('base64'))
  nonce && (nonce = nonce.toString('base64'))
  userData && (userData = userData.toString('base64'))
  if (!publicKey) { publicKey = 'null' }
  if (!nonce) { nonce = 'null' }
  if (!userData) { userData = 'null' }
  const bin = '/bin/attest'
  const cmd = `${bin} ${publicKey} ${nonce} ${userData}`
  return new Promise((res, rej) => {
    exec(cmd, { env: { PROD }}, (error, stdout, stderr) => {
      if (error) { return rej(new Error(`attest error ${error.code} ${stderr}`)) }
      const doc = stdout.trim()
      res(Buffer.from(doc, 'base64'))
    })
  })
}
