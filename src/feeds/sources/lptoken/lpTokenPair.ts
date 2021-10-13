import BigNumber from 'bignumber.js'
import throttle from 'lodash.throttle'
import { SolinkSubmitterConfig, SolinkLpTokenHolderConfig } from '../../../config'
import { IPrice, SubAggregatedFeeds } from '../../PriceFeed'
import { LpToken, ACCOUNT_CHANGED, AccountChanged, oraclePrice } from './lptoken'

const DELAY_TIME = 1000
const STABLE_ORACLE = 'usd:usd'

export class LpTokenPair {
  private addresses: string[] = []
  private oracles = new Map<string, oraclePrice>()

  constructor(
    private pair: string,
    private lpToken: LpToken,
    private config: SolinkSubmitterConfig,
    private subAggregatedFeeds: SubAggregatedFeeds
  ) {}

  init() {
    if (!this.config.lpToken) {
      this.lpToken.log.warn(`config incorrect for pair ${this.pair}`)
      return
    }

    this.addresses.push(this.config.lpToken.lpTokenAddress)
    this.addresses.push(this.config.lpToken.ammOpenOrders)
    this.addresses.push(this.config.lpToken.ammId)
    this.addresses.push(this.config.lpToken.holders.base.address)
    this.addresses.push(this.config.lpToken.holders.quote.address)

    const generatePriceThrottle = throttle(this.generatePrice, DELAY_TIME, {
      trailing: true,
      leading: false
    })
    this.lpToken.emitter.on(ACCOUNT_CHANGED, (changed: AccountChanged) => {
      if (this.addresses.includes(changed.address)) {
        generatePriceThrottle()
      }
    })

    this.oracles.set(STABLE_ORACLE, {
      price: 1,
      decimals: 0
    });

    Object.keys(this.subAggregatedFeeds).forEach(async (name) => {
      const feed = this.subAggregatedFeeds[name];
      for await (let price of feed.medians()) {
        this.lpToken.log.debug('sub oracle price ', { price });
        this.oracles.set(name, {
          price: price.value,
          decimals: price.decimals
        })
        generatePriceThrottle();
      }
    });
  }

  getAmountInUSD = (holder: SolinkLpTokenHolderConfig, openOrderAmount: string, ammAmount: string): BigNumber => {
    const tokenAccount = this.lpToken.getHolderAccount(holder.address)
    const oracle = this.oracles.get(holder.feed.name)
    if (!tokenAccount) {
      this.lpToken.log.debug('no token holder', { pair: this.pair, symbol: holder.symbol });
      throw new Error('no token holder values, it is ok if in warm-up phase')
    }
    if (!oracle) {
      this.lpToken.log.debug('no oracle price', { pair: this.pair, name: holder.feed.name });
      throw new Error(`no oracle price for ${holder.feed.name}, it is ok if in warm-up phase`)
    }
    const liquidity = new BigNumber(tokenAccount.amount.toString())
      .plus(new BigNumber(openOrderAmount))
      .minus(new BigNumber(ammAmount))

    this.lpToken.log.debug('pool liquidity', { liquidity: liquidity.toString(), symbol: holder.symbol, pair: this.pair });
    const value = new BigNumber(liquidity)
      .times(new BigNumber(oracle.price))
      .multipliedBy(
        new BigNumber(10).pow(-holder.decimals - oracle.decimals)
      )

    this.lpToken.log.debug('pool liquidity value', { value: value.toString(), symbol: holder.symbol, pair: this.pair });

    return value
  }

  getTotalValue = () => {
    try {
      if (!this.config || !this.config.lpToken) {
        throw new Error('no lp token config')
      }
      const ammOpenOrders = this.config?.lpToken?.ammOpenOrders;
      const ammId = this.config?.lpToken?.ammId;
      const openOrderInfo = this.lpToken.getOpenOrdersInfo(ammOpenOrders);
      if (ammOpenOrders && !openOrderInfo) {
        throw new Error(`no open order info ${ammOpenOrders}`)
      }
      const ammInfo = this.lpToken.getAmmInfo(ammId);
      if (ammId && !ammInfo) {
        throw new Error(`no amm info ${ammId}`)
      }

      const baseAmount = this.getAmountInUSD(
        this.config.lpToken.holders.base,
        openOrderInfo?.baseTokenTotal || '0',
        ammInfo?.needTakePnlPc || '0'
      )

      const quoteAmount = this.getAmountInUSD(
        this.config.lpToken.holders.quote,
        openOrderInfo?.quoteTokenTotal || '0',
        ammInfo?.needTakePnlPc || '0'
      )
      
      return new BigNumber(baseAmount).plus(quoteAmount)
    } catch (err) {
      this.lpToken.log.warn('get total value failed', { name: this.pair, err: `${err}`});
      return undefined;
    }
  }

  generatePrice = () => {
    if (!this.config.lpToken) {
      return
    }

    const lpTokenInfo = this.lpToken.getLpTokenAccount(
      this.config.lpToken.lpTokenAddress
    )

    if (!lpTokenInfo) {
      this.lpToken.log.debug('unable to get lp token account')
      return
    }
  
    const total = this.getTotalValue();
    if (!total) {
      return
    }

    const lpTokenPrice = total.div(
      new BigNumber(lpTokenInfo.supply.toString()).times(
        new BigNumber(10).pow(-lpTokenInfo.decimals)
      )
    )

    const value = lpTokenPrice
      .times(new BigNumber(10).pow(this.config.lpToken.decimals))
      .integerValue()
      .toNumber()

    const price: IPrice = {
      source: this.lpToken.source,
      pair: this.pair,
      decimals: this.config.lpToken.decimals,
      value,
      time: Date.now()
    }

    // emit new price
    this.lpToken.onMessage(price)
  }
}
