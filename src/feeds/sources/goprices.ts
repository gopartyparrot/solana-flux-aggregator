import { FeedSource, SolinkSubmitterConfig } from '../../config'
import { log } from '../../log'
import { IPrice, PriceFeed } from '../PriceFeed'
import axios from 'axios'
import BigNumber from 'bignumber.js'

export class GOPrices extends PriceFeed {
  // go prices feed must have 6 decimals
  // public decimals = 6
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

    if (!config.priceMint) {
      this.log.error('go prices: config missing price mint', { pair })
      return
    }
    const mint = config.priceMint
    const relativeTo = config.relativeTo ?? ''
    const useEwma = config.useEwma ?? false

    this.pairs.push(pair)

    this.fetchPrice(pair, mint, relativeTo, useEwma)
    setInterval(() => {
      this.fetchPrice(pair, mint, relativeTo, useEwma).catch(error => {
        this.log.error('go prices error', { pair, error: `${error}` })
      })
    }, 60_000)
  }

  async fetchPrice(
    pair: string,
    mint: string,
    relativeTo: string,
    useEwma: boolean
  ) {
    if (!this.priceURL) {
      this.log.debug('go prices url not set', { mint })
      return
    }
    this.log.debug('go prices fetch', { mint })
    const { data } = await axios.get(`${this.priceURL}/api/valuations/${mint}`)

    let decimals = 6
    switch (pair) {
      case 'usdc:btc':
        decimals = 10
        break
      case 'sol:usd':
        decimals = 2
        break
      default: // prt:usd
        decimals = 6
        break
    }

    let value = this.parsePrice(data.dollar, decimals)
    if (relativeTo) {
      value = this.parsePrice(data.relative[relativeTo], decimals)
    }
    if (useEwma) {
      value = this.parsePrice(data.ewma, decimals)
    }

    const price: IPrice = {
      source: this.source,
      pair,
      decimals,
      value,
      time: Date.now()
    }
    this.onMessage(price)
  }

  parsePrice(price: number, decimals: number) {
    return new BigNumber(price)
      .shiftedBy(decimals)
      .decimalPlaces(0, BigNumber.ROUND_FLOOR)
      .toNumber()
  }
}
