import { PublicKey } from '@solana/web3.js'
import fs from 'fs'
import BN from 'bn.js'

export function jsonReviver(_key: string, val: any) {
  if (val && typeof val == 'object') {
    if (val['type'] == 'PublicKey') {
      return new PublicKey(val.base58)
    }

    if (val['type'] == 'Buffer') {
      return Buffer.from(val.hex, 'hex')
    }
  }
  return val
}

const toJSONModifiers = {
  PublicKey: (instance: PublicKey) => ({
    type: 'PublicKey',
    base58: instance.toBase58()
  }),
  BN: (instance: BN) => ({
    type: 'BN',
    data: instance.toString()
  }),
  Buffer: (instance: Buffer) => ({
    type: 'Buffer',
    data: instance.toString('hex')
  })
}

function formatObj(obj: any): any {
  if (obj == null) {
    return obj
  }

  if (Array.isArray(obj)) {
    return Array.prototype.map.call(obj, element => formatObj(element))
  }

  if (typeof obj == 'object') {
    const modifier = toJSONModifiers[obj.constructor.name]
    if (!!modifier) {
      return modifier(obj)
    }
    let newobj: any = {}
    for (let tuple of Object.entries(obj)) {
      let [k, v]: [string, any] = tuple
      newobj[k] = formatObj(v)
    }

    return newobj
  }
  return obj
}

export function jsonReplacer(key: string, value: any) {
  return formatObj(value)
}

export function loadJSONFile<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8'), jsonReviver)
}
