import pako from 'pako'
import { FeedSource } from '../../config'
import { log } from '../../log'
import { IPrice, PriceFeed } from '../PriceFeed'

export class OKEx extends PriceFeed {
  public source = FeedSource.OKEX
  protected log = log.child({ class: this.source })
  protected baseurl = 'wss://real.okex.com:8443/ws/v3'

  parseMessage(data) {
    const message = pako.inflate(data, { raw: true, to: 'string' })
    const payload = JSON.parse(message)

    // {
    //   "table":"spot/ticker",
    //   "data": [
    //     {
    //       "last":"2819.04",
    //       "open_24h":"2447.02",
    //       "best_bid":"2818.82",
    //       "high_24h":"2909.68",
    //       "low_24h":"2380.95",
    //       "open_utc0":"2704.92",
    //       "open_utc8":"2610.12",
    //       "base_volume_24h":"215048.740665",
    //       "quote_volume_24h":"578231392.9501",
    //       "best_ask":"2818.83",
    //       "instrument_id":"ETH-USDT",
    //       "timestamp":"2021-05-26T11:46:11.826Z",
    //       "best_bid_size":"0.104506",
    //       "best_ask_size":"21.524559",
    //       "last_qty":"0.210619"
    //     }
    //   ]
    // }

    if (payload.table != 'spot/ticker') {
      return
    }

    // "BTC-USDT" => "btc:usd"
    const [baseCurrency, quoteCurrency] = (
      payload.data[0].instrument_id as string
    )
      .toLowerCase()
      .split('-')
    // assume that quote is always any form of usd/usdt/usdc so map to usd
    const pair = `${baseCurrency}:${quoteCurrency.slice(0, 3)}`
    const price: IPrice = {
      source: this.source,
      pair,
      decimals: 2,
      value: Math.floor(payload.data[0].last * 100),
      time: Date.now()
    }

    return price
  }

  async handleSubscribe(pair: string) {
    // "btc:usd" => "BTC-USDT"
    const [baseCurrency, quoteCurrency] = pair.split(':')
    const targetPair = `spot/ticker:${baseCurrency.toUpperCase()}-${
      quoteCurrency.toLowerCase() === 'usd' ? 'USDT' : quoteCurrency
    }`
    this.conn.send(
      JSON.stringify({
        op: 'subscribe',
        args: [targetPair]
      })
    )
  }
}
