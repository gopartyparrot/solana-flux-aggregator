import BigNumber from 'bignumber.js'

import { SolinkSubmitterConfig } from '../../../config'
import { IPrice } from '../../PriceFeed'
import { LpToken, ACCOUNT_CHANGED, AccounChanged } from './lptoken'

export class LpTokenPair {
  private addresses: string[] = []
  constructor(
    private pair: string,
    private lpToken: LpToken,
    private config: SolinkSubmitterConfig
  ) {}

  init() {
    if (!this.config.lpToken) {
      this.lpToken.log.warn(`config incorrect for pair ${this.pair}`)
      return
    }

    this.addresses.push(this.config.lpToken.lpTokenAddress)
    this.config.lpToken.holders.forEach(holder => {
      this.addresses.push(holder.address)
      this.addresses.push(holder.oracle)
    })
    this.lpToken.emitter.on(ACCOUNT_CHANGED, (changed: AccounChanged) => {
      if (this.addresses.includes(changed.address)) {
        this.generatePrice()
      }
    })
  }

  generatePrice() {
    if (!this.config.lpToken) {
      return
    }
    const lpTokenInfo = this.lpToken.getLpTokenAccount(
      this.config.lpToken.lpTokenAddress
    )
    if (!lpTokenInfo) {
      throw new Error('unable to get account')
    }

    const total = this.config.lpToken.holders.reduce<BigNumber>(
      (total: BigNumber, holder) => {
        const tokenAccount = this.lpToken.getHolderAccount(holder.address)
        const oracle = this.lpToken.getOracle(holder.oracle)
        if (!tokenAccount || !oracle) {
          throw new Error('unable to get account')
        }

        const curValue = new BigNumber(tokenAccount.amount.toString())
          .times(new BigNumber(oracle.price))
          .multipliedBy(
            new BigNumber(10).pow(-holder.decimal - oracle.decimals)
          )

        return total.plus(curValue)
      },
      new BigNumber(0)
    )

    const lpTokenPrice = total.div(
      new BigNumber(lpTokenInfo.supply.toString()).times(
        new BigNumber(10).pow(-lpTokenInfo.decimals)
      )
    )

    const value = lpTokenPrice
      .times(new BigNumber(10).pow(this.lpToken.decimals))
      .integerValue()
      .toNumber()

    const price: IPrice = {
      source: this.lpToken.source,
      pair: this.pair,
      decimals: this.lpToken.decimals,
      value,
      time: Date.now()
    }

    // emit new price
    this.lpToken.onMessage(price)
  }
}
