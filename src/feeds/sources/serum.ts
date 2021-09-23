import { PublicKey } from '@solana/web3.js'
import { Market, Orderbook } from '@project-serum/serum'
import throttle from 'lodash.throttle'
import assert from 'assert'

import { conn as web3Conn } from '../../context'
import { FeedSource, SolinkSubmitterConfig } from '../../config'
import { log } from '../../log'
import { IPrice, PriceFeed, SubAggregatedFeeds } from '../PriceFeed'
import BigNumber from 'bignumber.js'

const DELAY_TIME = 100
const DEX_PID = new PublicKey('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin')

interface PairData {
  bestBidPrice: number | undefined
  bestOfferPrice: number | undefined
  decimals: number
}

export class Serum extends PriceFeed {
  public source = FeedSource.SERUM
  public decimals = 6
  public log = log.child({ class: this.source })
  public pairsData: {
    [key: string]: PairData
  } = {}

  protected baseurl = 'unused'

  async init() {
    this.log.debug('init', { baseurl: this.baseurl })
  }

  subscribe(
    pair: string,
    submitterConf?: SolinkSubmitterConfig,
    subAggregatedFeeds?: SubAggregatedFeeds
  ) {
    if (this.pairs.includes(pair)) {
      // already subscribed
      return
    }

    this.pairs.push(pair)

    this.doSubscribe(pair, submitterConf, subAggregatedFeeds)
  }

  async doSubscribe(
    pair: string,
    submitterConf?: SolinkSubmitterConfig,
    subAggregatedFeeds?: SubAggregatedFeeds
  ) {
    assert.ok(submitterConf, `Config error with ${this.source}`)
    assert.ok(
      submitterConf.serumMarketAddress,
      `Config error with ${this.source}`
    )
    // assert.ok(subAggregatedFeeds, `Config error with ${this.source}`)

    this.log.debug('subscribe pair', { pair, submitterConf })

    const market = await Market.load(
      web3Conn,
      new PublicKey(submitterConf.serumMarketAddress),
      {},
      DEX_PID
    )

    const bids = await market.loadBids(web3Conn)
    const asks = await market.loadAsks(web3Conn)
    const bestBid = bids.items(true).next().value
    const bestOffer = asks.items(false).next().value

    this.pairsData[pair] = {
      bestBidPrice: bestBid?.price,
      bestOfferPrice: bestOffer?.price,
      decimals: submitterConf.serumDecimals ?? this.decimals
    }

    const generatePriceThrottle = throttle(
      () => this.generatePrice(pair),
      DELAY_TIME,
      {
        trailing: true,
        leading: false
      }
    )

    generatePriceThrottle()

    web3Conn.onAccountChange(market.bidsAddress, async info => {
      const bids = Orderbook.decode(market, info.data)
      const newBestBid = bids.items(false).next().value
      this.pairsData[pair].bestBidPrice = newBestBid?.price
      generatePriceThrottle()
    })

    web3Conn.onAccountChange(market.asksAddress, async info => {
      const asks = Orderbook.decode(market, info.data)
      const newBestOffer = asks.items(false).next().value
      this.pairsData[pair].bestOfferPrice = newBestOffer?.price
      generatePriceThrottle()
    })
  }

  generatePrice(pair: string) {
    const pairData = this.pairsData[pair] || {}
    const bestPrices: number[] = [
      pairData.bestBidPrice,
      pairData.bestOfferPrice
    ].filter((v): v is number => typeof v === 'number' && !isNaN(v))
    if (bestPrices.length === 0) {
      return
    }
    this.log.debug('price', { bestPrices })

    const value = BigNumber.sum(...bestPrices)
      .times(new BigNumber(10).pow(pairData.decimals))
      .dividedBy(bestPrices.length)
      .toNumber()
    const price: IPrice = {
      source: this.source,
      pair,
      decimals: pairData.decimals,
      value,
      time: Date.now()
    }
    this.onMessage(price)
  }

  // web3.connect handle reconnection by itself
  checkConnection() {
    return true
  }

  // web3.connect handle reconnection by itself
  reconnect() {}

  //unused for lptoken price feed
  parseMessage(data: any): IPrice | undefined {
    return undefined
  }
  //unused for lptoken price feed
  handleSubscribe(pair: string): Promise<void> {
    return Promise.resolve()
  }
}
