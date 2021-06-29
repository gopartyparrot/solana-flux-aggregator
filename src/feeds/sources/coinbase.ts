import { FeedSource } from '../../config'
import { log } from '../../log'
import { IPrice, PriceFeed } from '../PriceFeed'

export class CoinBase extends PriceFeed {
  public source = FeedSource.COINBASE
  protected log = log.child({ class: this.source })
  protected baseurl = 'wss://ws-feed.pro.coinbase.com'

  parseMessage(data) {
    const payload = JSON.parse(data)

    // {
    //   "type": "ticker",
    //   "sequence": 22772426228,
    //   "product_id": "BTC-USD",
    //   "price": "53784.59",
    //   "open_24h": "58795.78",
    //   "volume_24h": "35749.39437842",
    //   "low_24h": "53221",
    //   "high_24h": "58799.66",
    //   "volume_30d": "733685.27275521",
    //   "best_bid": "53784.58",
    //   "best_ask": "53784.59",
    //   "side": "buy",
    //   "time": "2021-03-16T06:26:06.791440Z",
    //   "trade_id": 145698988,
    //   "last_size": "0.00474597"
    // }

    if (payload.type != 'ticker') {
      return
    }

    // "BTC-USD" => "btc:usd"
    const pair = (payload.product_id as string).replace('-', ':').toLowerCase()
    
    const price: IPrice = {
      source: this.source,
      pair,
      decimals: 2,
      value: this.parsePrice(payload.price),
      time: Date.now()
    }

    return price
  }

  parsePrice(price: number) {
    return Math.floor(price * 100);
  }

  async handleSubscribe(pair: string) {
    // "btc:usd" => "BTC-USD"    
    const targetPair = pair.replace(':', '-').toUpperCase()

    this.conn.send(
      JSON.stringify({
        type: 'subscribe',
        product_ids: [targetPair],
        channels: ['ticker']
      })
    )
  }
}

export class CoinBaseInverse extends CoinBase {
  public source = FeedSource.COINBASE_INVERSE

  parsePrice(price: number) {    
    // decimals is 8 (satoshi) + 8 (precision)
    return Math.floor(1 * 1e16 / price)
  }

  async handleSubscribe(pair: string) {
    super.handleSubscribe(pair.split(':').reverse().join(':'))
  }
}