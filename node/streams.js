const { Transform } = require('stream')

// https://doc.libsodium.org/secret-key_cryptography/secretstream
class EncryptStream extends Transform {
  constructor(sodium, key) {
    super()
    this.sodium = sodium
    const res = this.sodium.crypto_secretstream_xchacha20poly1305_init_push(key)
    this.state = res.state
    this.push(Buffer.from(res.header))
    this.out = []
  }

  _transform(chunk, encoding, callback) {
    const { sodium } = this
    const bytes = sodium.crypto_secretstream_xchacha20poly1305_push(this.state,
      chunk, null, sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
    )
    const buf = Buffer.from(bytes)
    const len = Buffer.allocUnsafe(4)
    len.writeUInt32BE(buf.byteLength)
    this.push(Buffer.concat([len, buf]))
    callback()
  }
}

// https://doc.libsodium.org/secret-key_cryptography/secretstream
class DecryptStream extends Transform {
  constructor(sodium, key) {
    super()
    this.sodium = sodium
    this.key = key
    this.state = null
    this.headBuf = Buffer.alloc(0)
    this.len = null
    this.buf = Buffer.alloc(0)
    this.out = []
  }

  _next() {
    if (this.len === null && this.buf.byteLength < 4) {
      return false
    } else if (this.len === null) {
      this.len = this.buf.readUInt32BE(0)
      this.buf = this.buf.slice(4)
    }

    if (this.buf.byteLength < this.len) {
      return false
    }

    const next = this.buf.slice(0, this.len)
    this.buf = this.buf.slice(this.len)
    this.len = null
    return next
  }

  _transform(chunk, encoding, callback) {
    const { sodium } = this
    if (this.state === null) {
      this.headBuf = Buffer.concat([this.headBuf, chunk])
      if (this.headBuf.byteLength < sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES) {
        return callback()
      }
      
      const head = this.headBuf.slice(0, sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES)
      const remainder = this.headBuf.slice(sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES)
      this.state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(head, this.key)
      if (remainder.byteLength > 0) {
        chunk = remainder
      } else {
        return callback()
      }
    }

    this.buf = Buffer.concat([this.buf, chunk])
    let next = this._next()

    while (next) {
      const res = sodium.crypto_secretstream_xchacha20poly1305_pull(this.state, next)
      if (!res) { throw new Error('stream decrypt error') }
      const buf = Buffer.from(res.message)
      this.out.push(buf)
      next = this._next()
    }

    next = this.out[0]
    while (next) {
      this.out.shift()
      const ok = this.push(next)
      if (!ok) { break }
      next = this.out[0]
    }

    callback()
  }
}

module.exports = { EncryptStream, DecryptStream }
