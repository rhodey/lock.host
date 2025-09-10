module.exports = function cache(ttl) {
  const map = {}

  const set = (key, value) => {
    const timer = setTimeout(() => {
      delete map[key]
    }, ttl)
    map[key] && clearTimeout(map[key].timer)
    map[key] = { timer, value }
    return value
  }

  const get = (key) => {
    const item = map[key]
    return item ? item.value : null
  }

  return { set, get }
}
