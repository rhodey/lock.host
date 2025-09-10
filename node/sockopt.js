const ffi = require('ffi-napi')
const ref = require('ref-napi')

const StructType = require('ref-struct-di')(ref)
const ArrayType = require('ref-array-di')(ref)
const CharArray = ArrayType(ref.types.char, 8)

const sockaddr_in = StructType({
  sin_family: ref.types.uint16,
  sin_port: ref.types.uint16,
  sin_addr: ref.types.uint32,
  sin_zero: CharArray,
})

const libc = ffi.Library('libc', {
  'getsockopt': ['int', ['int', 'int', 'int', ref.refType('void'), ref.refType('int')]],
  'inet_ntoa': ['string', [ref.types.uint32]],
  'ntohs': ['uint16', ['uint16']]
})

const SOL_IP = 0
const SO_ORIGINAL_DST = 80
const AF_INET = 2

// get SO_ORIGINAL_DST as set by iptables
function getsockopt(socket) {
  const dst = new sockaddr_in()
  const dstLen = ref.alloc('int', sockaddr_in.size)

  const result = libc.getsockopt(
    socket._handle.fd,
    SOL_IP,
    SO_ORIGINAL_DST,
    dst.ref(),
    dstLen
  )

  if (result !== 0) { throw new Error(`getsockopt failed with code: ${result}`) }
  if (dst.sin_family !== AF_INET) { throw new Error(`unexpected address family: ${dst.sin_family}`) }

  const ip = libc.inet_ntoa(dst.sin_addr)
  const port = libc.ntohs(dst.sin_port)

  return { ip, port }
}

module.exports = getsockopt
