import { FeedSource } from '../../config'
import { log } from '../../log'
import { IPrice, PriceFeed } from '../PriceFeed'

export class Binance extends PriceFeed {
  public source = FeedSource.BINANCE
  public decimals = 2
  protected log = log.child({ class: this.source })
  protected baseurl = 'wss://stream.binance.com/ws'

  parseMessage(data) {
    const payload = JSON.parse(data)

    // {
    //   "e": "trade",     // Event type
    //   "E": 123456789,   // Event time
    //   "s": "BNBBTC",    // Symbol
    //   "t": 12345,       // Trade ID
    //   "p": "0.001",     // Price
    //   "q": "100",       // Quantity
    //   "b": 88,          // Buyer order ID
    //   "a": 50,          // Seller order ID
    //   "T": 123456785,   // Trade time
    //   "m": true,        // Is the buyer the market maker?
    //   "M": true         // Ignore
    // }

    if (payload.e != 'trade') {
      return
    }
    // "btcbusd" => "btc:usd"
    // TODO: assume that the base symbol for the pair is 3 letters
    const baseCurrency = payload.s.slice(0, 3).toLowerCase()
    let quoteCurrency = payload.s.slice(3).toLowerCase()

    if (baseCurrency == 'btc') {
      quoteCurrency = 'usdc'
    } else {
      quoteCurrency = 'usd'
    }

    let pair = `${baseCurrency}:${quoteCurrency}`

    if (this.source === FeedSource.BINANCE_INVERSE) {
      pair = pair.split(':').reverse().join(':')
    }

    const price: IPrice = {
      source: this.source,
      pair,
      decimals: this.decimals,
      value: this.parsePrice(payload.p),
      time: Date.now()
    }

    return price
  }

  parsePrice(price: number) {
    return Math.floor(price * 100)
  }

  async handleSubscribe(pair: string) {
    // "btc:usd" => "btcbusd"
    let [baseCurrency, quoteCurrency] = pair.split(':')

    // Binance do not have USDC anymore, replace it to BUSD
    if (quoteCurrency == 'usdc' || quoteCurrency == 'usd') {
      quoteCurrency = 'busd'
    }

    const targetPair = `${baseCurrency}${quoteCurrency}@trade`.toLowerCase()

    this.conn.send(
      JSON.stringify({
        method: 'SUBSCRIBE',
        params: [targetPair],
        id: 1
      })
    )
  }
}

export class BinanceInverse extends Binance {
  public source = FeedSource.BINANCE_INVERSE
  public decimals = 10

  parsePrice(price: number) {
    return Math.floor((1 * 10 ** this.decimals) / price)
  }

  async handleSubscribe(pair: string) {
    super.handleSubscribe(pair.split(':').reverse().join(':'))
  }
}
