import { PublicKey } from '@solana/web3.js'
import { Market, Orderbook } from '@project-serum/serum'
import throttle from 'lodash.throttle'
import assert from 'assert'

import { conn as web3Conn } from '../../context'
import { FeedSource, SolinkSubmitterConfig } from '../../config'
import { log } from '../../log'
import { IPrice, PriceFeed, SubAggregatedFeeds } from '../PriceFeed'
import BigNumber from 'bignumber.js'

interface oraclePrice {
  price: number
  decimals: number
}

const DELAY_TIME = 100
const DEX_PID = new PublicKey('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin')

interface PairData {
  bestBidPrice: number | undefined
  bestOfferPrice: number | undefined
  decimals: number
  subPairName?: string
  subPrice?: oraclePrice
  generatePriceThrottle: () => void
  market: Market
  askSubId: number | null
  bidSubId: number | null
}

export class Serum extends PriceFeed {
  public source = FeedSource.SERUM
  public decimals = 6
  public lastUpdateTimeout = 12000
  public log = log.child({ class: this.source })
  public pairsData: {
    [key: string]: PairData
  } = {}

  protected baseurl = 'unused'
  protected lastAccountChangeTs: number = new Date().getTime()

  async init() {
    this.log.debug('init', { baseurl: this.baseurl })
  }

  subscribe(
    pair: string,
    submitterConf?: SolinkSubmitterConfig,
    subAggregatedFeeds?: SubAggregatedFeeds
  ) {
    if (submitterConf && submitterConf?.lastUpdateTimeout) {
      if (submitterConf?.lastUpdateTimeout < this.lastUpdateTimeout) {
        this.lastUpdateTimeout = submitterConf?.lastUpdateTimeout
      }
    }

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
    assert.ok(submitterConf.serum, `Config error with ${this.source}`)
    assert.ok(
      submitterConf.serum.marketAddress,
      `Config error with ${this.source}`
    )

    this.log.debug('subscribe pair', { pair, submitterConf })

    const market = await Market.load(
      web3Conn,
      new PublicKey(submitterConf.serum.marketAddress),
      {},
      DEX_PID
    )

    const generatePriceThrottle = throttle(
      () => this.generatePrice(pair),
      DELAY_TIME,
      {
        trailing: true,
        leading: false
      }
    )

    this.pairsData[pair] = {
      bestBidPrice: undefined,
      bestOfferPrice: undefined,
      decimals: submitterConf.serum.decimals ?? this.decimals,
      market,
      generatePriceThrottle,
      bidSubId: null,
      askSubId: null
    }

    await this.fetchLastestSerumPrice(pair)

    if (submitterConf.serum.feed) {
      const subName = submitterConf.serum.feed.name
      this.pairsData[pair].subPairName = subName
      assert.ok(subAggregatedFeeds, `Config error with ${this.source}`)
      const feed = subAggregatedFeeds[subName]
      assert.ok(feed, `Config error with ${this.source}`)
      const priceFeed = feed.medians()

      for await (let price of priceFeed) {
        // this.log.debug('sub oracle price ', { price });
        // this.set(name, {
        //   price: price.value,
        //   decimals: price.decimals
        // })

        this.pairsData[pair].subPrice = {
          price: price.value,
          decimals: price.decimals
        }
        this.pairsData[pair].generatePriceThrottle()
      }
    }

    generatePriceThrottle()

    this.subscribeBids(pair)
    this.subscribeAsks(pair)
  }

  async fetchLastestSerumPrice(pair: string) {
    const market = this.pairsData[pair].market
    const bids = await market.loadBids(web3Conn)
    const asks = await market.loadAsks(web3Conn)
    const bestBid = bids.items(true).next().value
    const bestOffer = asks.items(false).next().value
    this.log.debug('fetchLastestSerumPrice ', { bestBid, bestOffer, pair })

    this.pairsData[pair].bestBidPrice = bestBid?.price
    this.pairsData[pair].bestOfferPrice = bestOffer?.price
  }

  subscribeBids(pair: string) {
    const pairData = this.pairsData[pair]
    if (pairData.bidSubId) {
      web3Conn.removeAccountChangeListener(pairData.bidSubId)
      pairData.bidSubId = null
    }
    this.log.info('subscribe bids', { pair })
    const bidSubId = web3Conn.onAccountChange(
      pairData.market.bidsAddress,
      async info => {
        this.lastAccountChangeTs = new Date().getTime()
        const bids = Orderbook.decode(pairData.market, info.data)
        const newBestBid = bids.items(true).next().value
        this.log.debug('best bid price is changed', { newBestBid, pair })
        pairData.bestBidPrice = newBestBid?.price
        pairData.generatePriceThrottle()
      }
    )
    pairData.bidSubId = bidSubId
  }

  subscribeAsks(pair: string) {
    const pairData = this.pairsData[pair]
    if (pairData.askSubId) {
      web3Conn.removeAccountChangeListener(pairData.askSubId)
      pairData.askSubId = null
    }
    this.log.info('subscribe asks', { pair })
    const askSubId = web3Conn.onAccountChange(
      pairData.market.asksAddress,
      async info => {
        this.lastAccountChangeTs = new Date().getTime()
        const asks = Orderbook.decode(pairData.market, info.data)
        const newBestOffer = asks.items(false).next().value
        this.log.debug('best ask price is changed', { newBestOffer, pair })
        pairData.bestOfferPrice = newBestOffer?.price
        pairData.generatePriceThrottle()
      }
    )
    pairData.askSubId = askSubId
  }

  generatePrice(pair: string) {
    const pairData = this.pairsData[pair] || {}

    if (pairData.subPairName && !pairData.subPrice) {
      this.log.debug('sub oracle price is not ready')
      return
    }
    const bestPrices: number[] = [
      pairData.bestBidPrice,
      pairData.bestOfferPrice
    ].filter((v): v is number => typeof v === 'number' && !isNaN(v))
    if (bestPrices.length === 0) {
      return
    }
    this.log.debug('price', { bestPrices, subPrice: pairData.subPrice })

    let value = BigNumber.sum(...bestPrices)
      .times(new BigNumber(10).pow(pairData.decimals))
      .dividedBy(bestPrices.length)

    if (pairData.subPrice) {
      // convert price via another oracle price
      // e.g. original price PRT:SOL, subPrice: SOL:USD, to get PRT:USD
      value = value.times(
        new BigNumber(pairData.subPrice.price).div(
          new BigNumber(10).pow(pairData.subPrice.decimals)
        )
      )
    }

    const price: IPrice = {
      source: this.source,
      pair,
      decimals: pairData.decimals,
      value: value.toNumber(),
      time: Date.now()
    }
    this.onMessage(price)
  }

  // web3.connect handle reconnection by itself
  checkConnection() {
    const timeout = new Date().getTime() - this.lastAccountChangeTs
    if (timeout > this.lastUpdateTimeout) {
      return false
    }
    return true
  }

  // web3.connect handle reconnection by itself
  reconnect() {
    for (const [pair] of Object.entries(this.pairsData)) {
      this.log.info('reconnect serum price', { pair })
      this.fetchLastestSerumPrice(pair)
      this.subscribeAsks(pair)
      this.subscribeBids(pair)
    }
  }

  //unused for lptoken price feed
  parseMessage(data: any): IPrice | undefined {
    return undefined
  }
  //unused for lptoken price feed
  handleSubscribe(pair: string): Promise<void> {
    return Promise.resolve()
  }
}
