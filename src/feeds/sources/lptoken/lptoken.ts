import { PublicKey, AccountInfo } from '@solana/web3.js'
import { OpenOrders } from '@project-serum/serum'
import assert from 'assert'

import { FeedSource, SolinkSubmitterConfig } from '../../../config'
import { log } from '../../../log'
import { conn as web3Conn } from '../../../context'
import { IPrice, PriceFeed, SubAggregatedFeeds } from '../../PriceFeed'
import { LpTokenPair } from './lpTokenPair'
import {
  BNu64,
  MINT_LAYOUT,
  TOKEN_ACCOUNT_LAYOUT,
  getAmmLayout
} from './layout'
import { struct } from 'buffer-layout'
import { getMultipleAccounts } from '../../../utils'

export const ACCOUNT_CHANGED = 'ACCOUNT_CHANGED'

export interface oraclePrice {
  price: number
  decimals: number
}

export type TokenAccount = {
  amount: BNu64
}

export type MintInfo = {
  supply: BNu64
  decimals: number
}
export interface AccounChanged {
  address: string
}

export interface OpenOrdersInfo {
  baseTokenTotal: string
  quoteTokenTotal: string
}

export interface AmmInfo {
  needTakePnlCoin: string
  needTakePnlPc: string
}

export class LpToken extends PriceFeed {
  public source = FeedSource.LPTOKEN
  public decimals = 2
  public log = log.child({ class: this.source })

  protected baseurl = 'unused'
  private lpTokenAccounts = new Map<string, MintInfo>()
  private holderAccounts = new Map<string, TokenAccount>()
  private openOrders = new Map<string, OpenOrdersInfo>()
  private ammInfos = new Map<string, AmmInfo>()

  private subscribePollInterval: number = 20_000 // 20s

  public getLpTokenAccount(address: string) {
    return this.lpTokenAccounts.get(address)
  }

  public getHolderAccount(address: string) {
    return this.holderAccounts.get(address)
  }

  public getOpenOrdersInfo(address: string) {
    return this.openOrders.get(address)
  }

  public getAmmInfo(address: string) {
    return this.ammInfos.get(address)
  }

  async init() {
    this.log.debug('init', { baseurl: this.baseurl })
  }

  subscribe(
    pair: string,
    submitterConf?: SolinkSubmitterConfig,
    subAggregatedFeeds?: SubAggregatedFeeds
  ) {
    if (this.pairs.includes(pair)) {
      // already subscribed
      return
    }

    this.pairs.push(pair)

    this.doSubscribe(pair, submitterConf, subAggregatedFeeds).catch(() => {
      this.log.error('subscription failed for lptoken', {
        pair,
        lpTokenAddress: submitterConf?.lpToken?.lpTokenAddress
      })
    })
  }

  updateLpTokenChangedHandler(
    address: string,
    accountInfo: AccountInfo<Buffer>
  ) {
    const info = decodeMintInfo(accountInfo.data)
    this.lpTokenAccounts.set(address, info)
    this.log.debug('subscription update lptoken', {
      address,
      supply: info.supply.toString()
    })
  }

  updateTokenHolderChangedHandler(
    address: string,
    accountInfo: AccountInfo<Buffer>
  ) {
    const info = decodeAccountTokenInfo(accountInfo.data)
    this.holderAccounts.set(address, info)
    this.log.debug('subscription update holder balance', {
      address,
      amount: info.amount.toString()
    })
  }

  updateOpenOrdersChangedHandler(
    address: string,
    programId: string,
    accountInfo: AccountInfo<Buffer>
  ) {
    const OPEN_ORDERS_LAYOUT = OpenOrders.getLayout(new PublicKey(programId))
    const info = decodeOpenOrders(accountInfo.data, OPEN_ORDERS_LAYOUT)
    this.openOrders.set(address, info)
    this.log.debug('subscription update open orders', {
      address,
      info
    })
  }

  updateAmmChangedHandler(
    address: string,
    version: number,
    accountInfo: AccountInfo<Buffer>
  ) {
    const AMM_INFO_LAYOUT = getAmmLayout(version)
    const info = decodeAmm(accountInfo.data, AMM_INFO_LAYOUT)
    this.ammInfos.set(address, info)
    this.log.debug('subscription update amm', {
      address,
      info
    })
  }

  async doSubscribe(
    pair: string,
    submitterConf?: SolinkSubmitterConfig,
    subAggregatedFeeds?: SubAggregatedFeeds
  ) {
    assert.ok(submitterConf, `Config error with ${this.source}`)
    assert.ok(submitterConf.lpToken, `Config error with ${this.source}`)
    assert.ok(subAggregatedFeeds, `Config error with ${this.source}`)

    this.log.debug('subscribe pair', { pair, submitterConf })

    const lpTokenAddress = submitterConf.lpToken.lpTokenAddress
    const lpTokenPubkey = new PublicKey(lpTokenAddress)
    const lpTokenAccountInfo = await web3Conn.getAccountInfo(lpTokenPubkey)
    if (!lpTokenAccountInfo) {
      throw Promise.reject(`null lp token account ${lpTokenAddress}`)
    }
    this.updateLpTokenChangedHandler(lpTokenAddress, lpTokenAccountInfo)

    const openOrdersAddress = submitterConf.lpToken.ammOpenOrders
    if (openOrdersAddress) {
      const openOrdersPubkey = new PublicKey(openOrdersAddress)
      const openOrdersAccountInfo = await web3Conn.getAccountInfo(
        openOrdersPubkey
      )
      if (!openOrdersAccountInfo) {
        throw Promise.reject(`null open orders account ${openOrdersAddress}`)
      }
      this.updateOpenOrdersChangedHandler(
        openOrdersAddress,
        submitterConf.lpToken.serumProgramId,
        openOrdersAccountInfo
      )
    }

    const ammIdAddress = submitterConf.lpToken.ammId
    if (ammIdAddress) {
      const ammIdPubkey = new PublicKey(ammIdAddress)
      const ammIdAccountInfo = await web3Conn.getAccountInfo(ammIdPubkey)
      if (!ammIdAccountInfo) {
        throw Promise.reject(`null amm id account ${ammIdPubkey}`)
      }
      this.updateAmmChangedHandler(
        ammIdAddress,
        submitterConf.lpToken.version,
        ammIdAccountInfo
      )
    }

    const holders = [
      submitterConf.lpToken.holders.base,
      submitterConf.lpToken.holders.quote
    ]

    await Promise.all(
      holders.map(async holder => {
        // fetch and subscribe holder token account
        const holderPubkey = new PublicKey(holder.address)
        const holderAccountInfo = await web3Conn.getAccountInfo(holderPubkey)
        if (!holderAccountInfo) {
          throw Promise.reject(`null lp holder account ${holder.address}`)
        }
        this.updateTokenHolderChangedHandler(holder.address, holderAccountInfo)
      })
    )

    const pairHandler = new LpTokenPair(
      pair,
      this,
      submitterConf,
      subAggregatedFeeds
    )
    pairHandler.init()

    // Trigger first price submission on startup
    this.emitter.emit(ACCOUNT_CHANGED, { address: lpTokenAddress })

    // Polling new data
    setInterval(async () => {
      assert.ok(submitterConf, `Config error with ${this.source}`)
      assert.ok(submitterConf.lpToken, `Config error with ${this.source}`)

      const lpToken = submitterConf.lpToken

      lpToken.holders.base.address = ''

      const accountsMap = {
        [lpTokenAddress]: 'lpToken',
        [openOrdersAddress]: 'openOrders',
        [ammIdAddress]: 'ammId',
        [lpToken.holders.base.address]: 'holders',
        [lpToken.holders.quote.address]: 'holders'
      }

      const accountsData = await getMultipleAccounts(
        web3Conn,
        Object.keys(accountsMap).filter(i => !!i),
        'recent'
      )

      accountsData.keys.forEach((address, index) => {
        switch (accountsMap[address]) {
          case 'lpToken':
            this.updateLpTokenChangedHandler(address, accountsData.array[index])
            break
          case 'openOrders':
            this.updateOpenOrdersChangedHandler(
              openOrdersAddress,
              lpToken.serumProgramId,
              accountsData.array[index]
            )
            break
          case 'ammId':
            this.updateAmmChangedHandler(
              ammIdAddress,
              lpToken.version,
              accountsData.array[index]
            )
            break
          case 'holders':
            this.updateTokenHolderChangedHandler(
              address,
              accountsData.array[index]
            )
            break
          default:
            throw new Error(`unhandled account type ${accountsMap[address]}`)
        }
      })

      this.emitter.emit(ACCOUNT_CHANGED, { address: lpTokenAddress })
    }, this.subscribePollInterval)
  }

  // web3.connect handle reconnection by itself
  checkConnection() {
    return true
  }

  // web3.connect handle reconnection by itself
  reconnect() {}

  //unused for lptoken price feed
  parseMessage(data: any): IPrice | undefined {
    return undefined
  }
  //unused for lptoken price feed
  handleSubscribe(pair: string): Promise<void> {
    return Promise.resolve()
  }
}

function decodeAccountTokenInfo(data: Buffer): TokenAccount {
  const accountInfo = TOKEN_ACCOUNT_LAYOUT.decode(data)
  accountInfo.amount = BNu64.fromBuffer(accountInfo.amount)
  return accountInfo
}

function decodeMintInfo(data: Buffer): MintInfo {
  const info = MINT_LAYOUT.decode(data)
  info.supply = BNu64.fromBuffer(info.supply)
  info.decimals = info.decimals

  return info
}

function decodeOpenOrders(data: Buffer, layout: struct): OpenOrdersInfo {
  const parsed = layout.decode(data)
  const { baseTokenTotal, quoteTokenTotal } = parsed
  return {
    baseTokenTotal: baseTokenTotal.toString(),
    quoteTokenTotal: quoteTokenTotal.toString()
  }
}

function decodeAmm(data: Buffer, layout: struct): AmmInfo {
  const parsed = layout.decode(data)
  const { needTakePnlCoin, needTakePnlPc } = parsed
  return {
    needTakePnlCoin: needTakePnlCoin.toString(),
    needTakePnlPc: needTakePnlPc.toString()
  }
}
