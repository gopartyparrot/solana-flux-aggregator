import BigNumber from 'bignumber.js'
import throttle from 'lodash.throttle'
import { SolinkSubmitterConfig } from '../../../config'
import { IPrice, SubAggregatedFeeds } from '../../PriceFeed'
import { LpToken, ACCOUNT_CHANGED, AccounChanged, oraclePrice } from './lptoken'

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
    this.config.lpToken.holders.forEach(holder => {
      this.addresses.push(holder.address)
    })
    const generatePriceThrottle = throttle(this.generatePrice, DELAY_TIME, {
      trailing: true,
      leading: false
    })
    this.lpToken.emitter.on(ACCOUNT_CHANGED, (changed: AccounChanged) => {
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
      const priceFeed = feed.medians()
      for await (let price of priceFeed) {
        this.lpToken.log.debug('sub oracle price ', { price });
        this.oracles.set(name, {
          price: price.value,
          decimals: price.decimals
        })
        generatePriceThrottle();
      }
    });
  }

  getTotalValue = () => {
    try {
      return this.config?.lpToken?.holders.reduce<BigNumber>(
        (total: BigNumber, holder) => {
          const tokenAccount = this.lpToken.getHolderAccount(holder.address)
          const oracle = this.oracles.get(holder.feed.name)
          if (!tokenAccount || !oracle) {
            throw new Error('no token values or oracles')
          }

          const curValue = new BigNumber(tokenAccount.amount.toString())
            .times(new BigNumber(oracle.price))
            .multipliedBy(
              new BigNumber(10).pow(-holder.decimals - oracle.decimals)
            )
  
          return total.plus(curValue)
        },
        new BigNumber(0)
      );
    } catch (err) {
      this.lpToken.log.warn('get total value failed', err);
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
