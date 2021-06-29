import BigNumber from 'bignumber.js'
import EventEmitter from 'events'
import ReconnectingWebSocket from 'reconnecting-websocket'
import winston from 'winston'
import WebSocket from 'ws'
import { FeedSource } from '../config'

export const UPDATE = 'UPDATE'

export interface IPrice {
  source: string
  pair: string
  decimals: number
  value: number
  time: number
}

export interface IPriceFeed {
  [Symbol.asyncIterator]: () => AsyncIterator<IPrice>
}

export abstract class PriceFeed {
  public emitter = new EventEmitter()

  public conn!: ReconnectingWebSocket
  protected connected!: Promise<void>

  protected abstract get log(): winston.Logger
  protected abstract get baseurl(): string
  public abstract get source(): FeedSource

  // subscribed pairs. should re-subscribe on reconnect
  public pairs: string[] = []

  /**
   * init
   * - for websocket feed open connection (default)
   * - for file feed start ticker to read file
   * */
  async init() {
    this.log.debug('connecting', { baseurl: this.baseurl })

    this.connected = new Promise<void>(resolve => {
      const conn = new ReconnectingWebSocket(this.baseurl, [], { WebSocket })
      conn.addEventListener('open', () => {
        this.log.debug('connected')

        this.conn = conn

        for (let pair of this.pairs) {
          this.handleSubscribe(pair)
        }

        resolve()
      })

      conn.addEventListener('close', () => {
        this.log.info('ws closed', { source: this.source })
      })

      conn.addEventListener('error', err => {
        this.log.error('ws error', { source: this.source, err })
      })

      conn.addEventListener('message', msg => {
        this.log.debug('raw price update', { msg })
        try {
          const price = this.parseMessage(msg.data)
          if (price) {
            this.onMessage(price)
          }
        } catch (err) {
          this.log.warn(`on message err:`, { source: this.source, msg, err })
        }
      })
    })

    return this.connected
  }

  subscribe(pair: string) {
    if (this.pairs.includes(pair)) {
      // already subscribed
      return
    }

    this.pairs.push(pair)

    if (this.conn) {        
      // if already connected immediately subscribe
      this.handleSubscribe(pair)
    }
  }

  onMessage(price: IPrice) {
    this.log.debug('emit price update', { price })

    this.emitter.emit(UPDATE, price)
  }

  abstract parseMessage(data: any): IPrice | undefined
  // abstract parseMessage(pair: string)
  // abstract parseMessage(pair: string)
  abstract handleSubscribe(pair: string): Promise<void>
}
