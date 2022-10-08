import { FeedSource } from '../../config'
import { log } from '../../log'
import { IPrice, PriceFeed } from '../PriceFeed'

export class CoinBase extends PriceFeed {
  public source = FeedSource.COINBASE
  public decimals = 2
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
    let pair = (payload.product_id as string).replace('-', ':').toLowerCase()

    if (this.source === FeedSource.COINBASE_INVERSE) {
      pair = pair.split(':').reverse().join(':')
      // replace back the busd to usdc to allow matching pair name
      pair = pair.replace("usd", "usdc")
    }

    const price: IPrice = {
      source: this.source,
      pair,
      decimals: this.decimals,
      value: this.parsePrice(payload.price),
      time: Date.now()
    }

    return price
  }

  parsePrice(price: number) {
    return Math.floor(price * 100)
  }

  async handleSubscribe(pair: string) {
    // Coinbase do not have anymore USDC pairs, everything is USD
    pair = pair.replace('usdc', 'usd')

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
  public decimals = 10

  parsePrice(price: number) {
    return Math.floor((1 * 10 ** this.decimals) / price)
  }

  async handleSubscribe(pair: string) {
    super.handleSubscribe(pair.split(':').reverse().join(':'))
  }
}
