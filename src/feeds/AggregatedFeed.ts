import EventEmitter from 'events'
import { Logger } from 'winston'
import { FeedSource, SolinkSubmitterConfig } from '../config'
import { ErrorNotifier } from '../ErrorNotifier'
import { log } from '../log'
import { metricOracleFeedPrice } from '../metrics'
import { eventsIter, median } from '../utils'
import { IPrice, PriceFeed, UPDATE } from './PriceFeed'

export class AggregatedFeed {
  public emitter = new EventEmitter()
  public prices: IPrice[] = []
  public logger: Logger
  public lastUpdate = new Map<string, { feed: PriceFeed; updatedAt: number }>()
  public lastUpdateTimeout = 120000 // 2m

  // assume that the feeds are already connected
  constructor(
    public feeds: PriceFeed[],
    public pair: string,
    private oracle: string,
    private errorNotifier?: ErrorNotifier,
    private submitterConf?: SolinkSubmitterConfig
  ) {
    this.logger = log.child({
      oracle: oracle,
      aggregator: pair
    })

    this.subscribe()
    this.startStaleChecker()
  }

  private subscribe() {
    const pair = this.pair

    let i = 0
    for (let feed of this.feeds) {
      feed.subscribe(pair, this.submitterConf)
      this.lastUpdate.set(`${feed.source}-${pair}`, {
        feed,
        updatedAt: Date.now()
      })
      this.logger.info('aggregated feed subscribed', { feed: feed.source })

      const index = i
      i++

      // store the price updates in the ith position of `this.prices`
      feed.emitter.on(UPDATE, (price: IPrice) => {
        if (price.pair != pair) {
          return
        }

        metricOracleFeedPrice.set(
          {
            submitter: this.oracle,
            feed: pair,
            source: feed.source
          },
          price.value / 10 ** price.decimals
        )

        this.prices[index] = price
        this.lastUpdate.set(`${feed.source}-${pair}`, {
          feed,
          updatedAt: Date.now()
        })
        this.onPriceUpdate(price)
      })
    }
  }

  private onPriceUpdate(price: IPrice) {
    // log.debug("aggregated price update", {
    //   prices: this.prices,
    //   median: this.median,
    // })
    this.emitter.emit(UPDATE, this)
  }

  private startStaleChecker() {
    if (!this.errorNotifier) {
      return
    }
    setInterval(() => {
      // Check feeds websocket connection
      for (const feed of this.feeds) {
        if (!feed.checkConnection()) {
          const meta = {
            feed: this.pair,
            source: feed.source,
            submitter: this.oracle
          }
          this.logger.error(`Websocket is not connected`, meta)
          this.errorNotifier?.notifyCritical(
            'AggregatedFeed',
            `Websocket is not connected, try to reconnect`,
            meta
          )
          feed.reconnect()
        }
      }

      // Check feeds last update event
      const now = Date.now()
      for (const feedInfo of this.lastUpdate.values()) {
        if (now - feedInfo.updatedAt > this.lastUpdateTimeout) {
          const meta = {
            feed: this.pair,
            source: feedInfo.feed.source,
            submitter: this.oracle,
            lastUpdate: new Date(feedInfo.updatedAt).toISOString()
          }
          this.logger.error(
            `No price data from websocket, call reconnect`,
            meta
          )
          this.errorNotifier?.notifyCritical(
            'AggregatedFeed',
            `No price data from websocket, try to reconnect`,
            meta
          )
          feedInfo.feed.reconnect()
        }
      }
    }, this.lastUpdateTimeout / 2)
  }

  async *medians() {
    for await (let _ of this.updates()) {
      const price = this.median
      if (price) {
        yield price
      }
    }
  }

  async *updates() {
    for await (let _ of eventsIter<AggregatedFeed>(this.emitter, 'UPDATE')) {
      yield this
    }
  }

  get median(): IPrice | undefined {
    const prices = this.prices.filter(price => price != undefined)

    if (prices.length == 0) {
      return
    }

    const now = Date.now()
    const acceptedTime = now - 2 * 60 * 1000 // 5 minutes ago


    const values = prices
      // accept only prices > 0 that have been updated within 5 minutes
      .filter(price => price.value > 0 && price.time >= acceptedTime)
      // Temporary ignore FTX prices from median
      .filter(price => price.source !== FeedSource.FTX)
      .map(price => price.value)

    return {
      source: 'median',
      pair: prices[0].pair,
      decimals: prices[0].decimals,
      value: median(values),
      time: now
    }
  }
}
