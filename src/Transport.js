'use strict'

// https://github.com/nodejs/quic/blob/master/doc/api/quic.md
const Quic = require('quic')
const Fs = require('fs')
const Path = require('path')
const { AbortError } = require('abortable-iterator')
const log = require('debug')('libp2p:quic:Transport')
const Multiaddr = require('multiaddr')
const PeerId = require('peer-id')
const Listener = require('./Listener')
const toCapableConn = require('./to-capable-conn')
const { NotDialableError } = require('./errors')
const { privateKeyToCertificate } = require('./crypto')

const ca = Fs.readFileSync(Path.join(__dirname, '..', 'ca1-cert.pem'))

// https://github.com/libp2p/go-libp2p-tls/blob/702fd537463ac5a1ef209c0b64457da0d1251b3f/crypto.go#L24
const alpn = 'libp2p'

class Transport {
  constructor ({ privateKey }) {
    this._privateKey = privateKey
  }

  async dial (addr, options) {
    options = options || {}

    if (options.signal && options.signal.aborted) {
      throw new AbortError()
    }

    if (typeof addr === 'string') {
      addr = Multiaddr(addr)
    } else if (!Multiaddr.isMultiaddr(addr)) {
      throw new TypeError('address is not a multiaddr')
    }

    if (!isQuicAddr(addr)) {
      throw new NotDialableError()
    }

    log('dial %s', addr)

    // TODO: extract key and cert from libp2p private key
    // https://github.com/libp2p/go-libp2p-tls/blob/master/crypto.go#L153
    const { address, port } = addr.nodeAddress()
    const socket = Quic.createSocket()
    socket.on('error', err => log('socket error', err))
    const certInfo = privateKeyToCertificate(this._privateKey)
    const session = socket.connect({
      key: this._privateKey,
      cert: certInfo.cert,
      ca,
      address,
      port,
      alpn
    })
    session.on('error', err => log('session error', err))

    await new Promise(resolve => session.on('secure', resolve))
    log('dial to %s is now secure', addr)

    const localAddr = (() => {
      const { address, port, family } = socket.address
      return `/ip${family.slice(-1)}/${address}/udp/${port}/quic`
    })()

    if (!this._localPeer) {
      this._localPeer = await PeerId.createFromPrivateKey(this._privateKey)
    }

    return toCapableConn({
      socket,
      session,
      localAddr,
      remoteAddr: addr,
      localPeer: this._localPeer
    }, { signal: options.signal })
  }

  createListener (options, handler) {
    if (typeof options === 'function') {
      handler = options
      options = {}
    }
    options = options || {}
    return new Listener({
      handler,
      privateKey: this._privateKey,
      upgrader: this._upgrader
    }, options)
  }

  filter (addrs) {
    // TODO: PR to mafmt
    // TODO: filter correctly circuit addrs
    return (Array.isArray(addrs) ? addrs : [addrs]).filter(isQuicAddr)
  }
}

function isQuicAddr (addr) {
  return `${addr}`.includes('quic')
}

module.exports = Transport
