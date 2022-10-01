import { FeedSource, SolinkSubmitterConfig } from '../../config'
import { log } from '../../log'
import { IPrice, PriceFeed } from '../PriceFeed'
import axios from 'axios'
import BigNumber from 'bignumber.js'

export class GOPrices extends PriceFeed {
  // go prices feed must have 6 decimals
  public decimals = 6
  public source = FeedSource.GOPRICES
  protected log = log.child({ class: this.source })
  protected baseurl = ''

  constructor(private priceURL: string) {
    super()
  }

  async init() {
    this.log.debug('init')
  }

  checkConnection() {
    this.log.debug('check connection')
    return true
  }

  reconnect() {
    this.log.debug('reconnect')
  }

  //unused
  parseMessage(_: any): IPrice | undefined {
    return undefined
  }

  //unused
  handleSubscribe(_: string): Promise<void> {
    return Promise.resolve()
  }

  subscribe(pair: string, config: SolinkSubmitterConfig) {
    if (this.pairs.includes(pair)) {
      // already subscribed
      return
    }

    if (!config.tokenMint) {
      this.log.error('go prices config missing token mint', { pair })
      return
    }
    const mint = config.tokenMint
    const relativeTo = config.relativeTo ?? ''

    this.pairs.push(pair)

    this.fetchPrice(pair, mint, relativeTo)
    setInterval(() => {
      this.fetchPrice(pair, mint, relativeTo).catch(error => {
        this.log.error('go prices error', { pair, error: `${error}` })
      })
    }, 60_000)
  }

  async fetchPrice(pair: string, mint: string, relativeTo: string) {
    if (!this.priceURL) {
      this.log.debug('go prices url not set', { mint })
      return
    }
    this.log.debug('go prices fetch', { mint })
    const { data } = await axios.get(`${this.priceURL}/api/valuations/${mint}`)

    let value = this.parsePrice(data.dollar)
    if (relativeTo) {
      value = this.parsePrice(data.relative[relativeTo])
    }

    const price: IPrice = {
      source: this.source,
      pair,
      decimals: this.decimals,
      value,
      time: Date.now()
    }
    this.onMessage(price)
  }

  parsePrice(price: number) {
    return new BigNumber(price)
      .shiftedBy(this.decimals)
      .decimalPlaces(0, BigNumber.ROUND_FLOOR)
      .toNumber()
  }
}
