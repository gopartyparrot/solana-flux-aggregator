import { FeedSource } from '../../config'
import { log } from '../../log'
import { IPrice, PriceFeed } from '../PriceFeed'

export class FTX extends PriceFeed {
  public source = FeedSource.FTX
  protected log = log.child({ class: this.source })
  protected baseurl = 'wss://ftx.com/ws/'

  parseMessage(data) {
    const payload = JSON.parse(data)

    // ticker channel
    // {
    //   "channel": "ticker",
    //   "market": "BTC/USD",
    //   "type": "update",
    //   "data": {
    //     "bid": 54567,
    //     "ask": 54577,
    //     "bidSize": 0.0583,
    //     "askSize": 0.2051,
    //     "last": 54582,
    //     "time": 1615877027.551234
    //   }
    // }

    // trades channel
    // {
    //   channel: 'trades',
    //   market: 'SOL/USD',
    //   type: 'update',
    //   data: [
    //     {
    //       id: 1342006789,
    //       price: 29.86,
    //       size: 205.3,
    //       side: 'buy',
    //       liquidation: false,
    //       time: '2021-06-23T03:10:03.669178+00:00'
    //     },
    //   ]
    // }

    if (payload.type != 'update' || payload.channel != 'trades') {
      return
    }

    const pair = (payload.market as string).replace('/', ':').toLowerCase()
    const lastTrade = payload.data.pop()

    const price: IPrice = {
      source: this.source,
      pair,
      decimals: 2,
      value: this.parsePrice(lastTrade.price),
      time: Date.now()
    }

    return price
  }

  parsePrice(price: number) {
    return Math.floor(price * 100);
  }

  async handleSubscribe(pair: string) {
    // "btc:usd" => "BTC-USD"
    const targetPair = pair.replace(':', '/').toUpperCase()

    this.conn.send(
      JSON.stringify({
        op: 'subscribe',
        channel: 'trades',
        market: targetPair
      })
    )
  }
}

export class FTXInverse extends FTX {
  public source = FeedSource.FTX_INVERSE

  parsePrice(price: number) {    
    // decimals is 8 (satoshi) + 8 (precision)
    return Math.floor(1 * 1e16 / price)
  }

  async handleSubscribe(pair: string) {
    super.handleSubscribe(pair.split(':').reverse().join(':'))
  }
}