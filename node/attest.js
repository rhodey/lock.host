const fs = require('fs/promises')
const exec = require('child_process').exec

const timeout = 5_000
const PROD = process.env.PROD

async function readFile(path) {
  try {
    return await fs.readFile(path)
  } catch (err) {
    if (err.code === 'ENOENT') { return null }
    throw err
  }
}

module.exports = function getDoc(publicKey=null, nonce=null, userData=null, port=null) {
  return new Promise(async (res, rej) => {
    const timer = setTimeout(() => rej(new Error(`get doc timeout`)), timeout)

    // this is a not so pretty way to allow apps to put userData into the attest doc sent by net runtime
    // the app is in a whole different process than the runtime and so there is not an obvi answer
    // this was added to allow lockhost-keys to add the ec2 ami pcr into docs
    if (!userData && port) {
      const path = `/runtime/user_data_${port}`
      try {
        userData = await readFile(path)
      } catch (err) {
        clearTimeout(timer)
        return rej(err)
      }
    }

    publicKey && (publicKey = publicKey.toString('base64'))
    nonce && (nonce = nonce.toString('base64'))
    userData && (userData = userData.toString('base64'))
    if (!publicKey) { publicKey = 'null' }
    if (!nonce) { nonce = 'null' }
    if (!userData) { userData = 'null' }
    const bin = '/bin/attest'
    const cmd = `${bin} ${publicKey} ${nonce} ${userData}`
    exec(cmd, { env: { PROD }}, (error, stdout, stderr) => {
      clearTimeout(timer)
      if (error) { return rej(new Error(`attest error ${error.code} ${stderr}`)) }
      const doc = stdout.trim()
      res(Buffer.from(doc, 'base64'))
    })
  })
}
