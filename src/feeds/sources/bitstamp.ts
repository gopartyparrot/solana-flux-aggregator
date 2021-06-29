import { FeedSource } from '../../config'
import { log } from '../../log'
import { IPrice, PriceFeed } from '../PriceFeed'

export class BitStamp extends PriceFeed {
  public source = FeedSource.BITSTAMP
  protected log = log.child({ class: this.source })
  protected baseurl = 'wss://ws.bitstamp.net'

  parseMessage(data) {
    const payload = JSON.parse(data)

    // {
    //   "channel": "live_trades_btcusd",
    //   "data": {
    //     "amount": 0.02,
    //     "amount_str": "0.02000000",
    //     "buy_order_id": 1339567984607234,
    //     "id": 157699738,
    //     "microtimestamp": "1615877939649000",
    //     "price": 55008.3,
    //     "price_str": "55008.30",
    //     "sell_order_id": 1339567982141443,
    //     "timestamp": "1615877939",
    //     "type": 0
    //   },
    //   "event": "trade"
    // }

    if (payload.event != 'trade') {
      return
    }

    const channel = (payload.channel as string).replace('live_trades_', '')

    // assume that the symbols for the pair are 3 letters
    const pair = channel.slice(0, 3) + ':' + channel.slice(3)

    const price: IPrice = {
      source: this.source,
      pair,
      decimals: 2,
      value: Math.floor(payload.data.price * 100),
      time: Date.now()
    }

    return price
  }

  async handleSubscribe(pair: string) {
    // "btc:usd" => "BTCUSD"
    const targetPair = pair.replace(':', '').toUpperCase()

    this.conn.send(
      JSON.stringify({
        event: 'bts:subscribe',
        data: {
          channel: `live_trades_${targetPair.replace('/', '').toLowerCase()}`
        }
      })
    )
  }
}
