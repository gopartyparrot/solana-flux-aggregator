import * as BufferLayout from 'buffer-layout'
import BN from 'bn.js'
import assert from 'assert'

export const uint64 = (property: string = 'uint64'): Object => {
  return BufferLayout.blob(8, property)
}

export class BNu64 extends BN {
  /**
   * Convert to Buffer representation
   */
  toBuffer(): Buffer {
    const a = super.toArray().reverse()
    const b = Buffer.from(a)
    if (b.length === 8) {
      return b
    }
    assert(b.length < 8, 'u64 too large')

    const zeroPad = Buffer.alloc(8)
    b.copy(zeroPad)
    return zeroPad
  }

  /**
   * Construct a u64 from Buffer representation
   */
  static fromBuffer(buffer: typeof Buffer): BNu64 {
    assert(buffer.length === 8, `Invalid buffer length: ${buffer.length}`)
    return new BNu64(
      // @ts-ignore
      [...buffer]
        .reverse()
        .map(i => `00${i.toString(16)}`.slice(-2))
        .join(''),
      16
    )
  }
}

export const TOKEN_ACCOUNT_LAYOUT = BufferLayout.struct([
  BufferLayout.blob(64),
  uint64('amount'),
  BufferLayout.blob(93)
])

export const MINT_LAYOUT = BufferLayout.struct([
  BufferLayout.blob(36),
  uint64('supply'),
  BufferLayout.u8('decimals'),
  BufferLayout.blob(37)
])
