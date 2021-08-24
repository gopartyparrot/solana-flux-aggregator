import { PublicKey, AccountInfo } from '@solana/web3.js'
import { OpenOrders } from '@project-serum/serum'
import assert from 'assert'

import { FeedSource, SolinkSubmitterConfig } from '../../../config'
import { log } from '../../../log'
import { conn as web3Conn } from '../../../context'
import { IPrice, PriceFeed, SubAggregatedFeeds } from '../../PriceFeed'
import { LpTokenPair } from './lpTokenPair'
import { BNu64, MINT_LAYOUT, TOKEN_ACCOUNT_LAYOUT, getAmmLayout } from './layout'
import { struct } from 'buffer-layout'

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

  private subscribeAccountAddresses: string[] = []

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

  subscribe(pair: string, submitterConf?: SolinkSubmitterConfig, subAggregatedFeeds?: SubAggregatedFeeds) {
    if (this.pairs.includes(pair)) {
      // already subscribed
      return
    }

    this.pairs.push(pair)

    this.doSubscribe(pair, submitterConf, subAggregatedFeeds)
  }

  createLpTokenChangedHandler(address: string) {
    return (accountInfo: AccountInfo<Buffer>) => {
      const info = decodeMintInfo(accountInfo.data)
      this.lpTokenAccounts.set(address, info)
      this.emitter.emit(ACCOUNT_CHANGED, {
        address
      } as AccounChanged)
      this.log.debug('subscription update lptoken', {
        address,
        supply: info.supply.toString()
      })
    }
  }

  createTokenHolderChangedHandler(address: string) {
    return (accountInfo: AccountInfo<Buffer>) => {
      const info = decodeAccountTokenInfo(accountInfo.data)
      this.holderAccounts.set(address, info)
      this.emitter.emit(ACCOUNT_CHANGED, {
        address
      } as AccounChanged)
      this.log.debug('subscription update holder balance', {
        address,
        amount: info.amount.toString()
      })
    }
  }

  createOpenOrdersChangedHandler(address: string, layout: any) {
    return (accountInfo: AccountInfo<Buffer>) => {

      const info = decodeOpenOrders(accountInfo.data, layout)
      this.openOrders.set(address, info)
      this.emitter.emit(ACCOUNT_CHANGED, {
        address
      } as AccounChanged)
      this.log.debug('subscription update open orders', {
        address,
        info
      })
    }
  }


  createAmmChangedHandler(address: string, layout: any) {
    return (accountInfo: AccountInfo<Buffer>) => {

      const info = decodeAmm(accountInfo.data, layout)
      this.ammInfos.set(address, info)
      this.emitter.emit(ACCOUNT_CHANGED, {
        address
      } as AccounChanged)
      this.log.debug('subscription update amm', {
        address,
        info
      })
    }
  }


  async doSubscribe(pair: string, submitterConf?: SolinkSubmitterConfig, subAggregatedFeeds?: SubAggregatedFeeds) {
    assert.ok(submitterConf, `Config error with ${this.source}`)
    assert.ok(submitterConf.lpToken, `Config error with ${this.source}`)
    assert.ok(subAggregatedFeeds, `Config error with ${this.source}`)

    this.log.debug('subscribe pair', { pair, submitterConf })

    const lpTokenAddress = submitterConf.lpToken.lpTokenAddress
    if (!this.subscribeAccountAddresses.includes(lpTokenAddress)) {
      const lpTokenPubkey = new PublicKey(lpTokenAddress)
      const lpTokenAccountInfo = await web3Conn.getAccountInfo(lpTokenPubkey)
      if (!lpTokenAccountInfo) {
        throw Promise.reject(`null lp token account ${lpTokenAddress}`)
      }

      const lpTokenMintInfo = decodeMintInfo(lpTokenAccountInfo.data)

      this.log.debug('lp token fetched', {
        pair,
        lpTokenAddress,
        supply: lpTokenMintInfo.supply.toString()
      })

      this.lpTokenAccounts.set(lpTokenAddress, lpTokenMintInfo)

      web3Conn.onAccountChange(
        lpTokenPubkey,
        this.createLpTokenChangedHandler(lpTokenAddress)
      )
      this.subscribeAccountAddresses.push(lpTokenAddress)
    }

    const openOrdersAddress = submitterConf.lpToken.ammOpenOrders
    if (openOrdersAddress && !this.subscribeAccountAddresses.includes(openOrdersAddress)) {
      const openOrdersPubkey = new PublicKey(openOrdersAddress)
      const openOrdersAccountInfo = await web3Conn.getAccountInfo(openOrdersPubkey)
      if (!openOrdersAccountInfo) {
        throw Promise.reject(`null open orders account ${openOrdersAddress}`)
      }
      const OPEN_ORDERS_LAYOUT = OpenOrders.getLayout(new PublicKey(submitterConf.lpToken.serumProgramId))
      const openOrdersInfo = decodeOpenOrders(openOrdersAccountInfo.data, OPEN_ORDERS_LAYOUT);

      this.log.debug('lp token open orders fetched', {
        pair,
        openOrdersInfo
      })

      this.openOrders.set(openOrdersAddress, openOrdersInfo)

      web3Conn.onAccountChange(
        openOrdersPubkey,
        this.createOpenOrdersChangedHandler(openOrdersAddress, OPEN_ORDERS_LAYOUT)
      )
      this.subscribeAccountAddresses.push(openOrdersAddress)
    }

    const ammIdAddresss = submitterConf.lpToken.ammId
    if (ammIdAddresss && !this.subscribeAccountAddresses.includes(ammIdAddresss)) {
      const ammIdPubkey = new PublicKey(ammIdAddresss)
      const ammIdAccountInfo = await web3Conn.getAccountInfo(ammIdPubkey)
      if (!ammIdAccountInfo) {
        throw Promise.reject(`null amm id account ${ammIdPubkey}`)
      }

      const AMM_INFO_LAYOUT = getAmmLayout(submitterConf.lpToken.version)
      const ammInfo = decodeAmm(ammIdAccountInfo.data, AMM_INFO_LAYOUT);

      this.log.debug('lp token amm info fetched', {
        pair,
        ammInfo
      })

      this.ammInfos.set(ammIdAddresss, ammInfo)

      web3Conn.onAccountChange(
        ammIdPubkey,
        this.createAmmChangedHandler(ammIdAddresss, AMM_INFO_LAYOUT)
      )
      this.subscribeAccountAddresses.push(ammIdAddresss)
    }

    const holders = [submitterConf.lpToken.holders.base, submitterConf.lpToken.holders.quote];

    await Promise.all(
      holders.map(async holder => {
        // fetch and subscribe holder token account
        if (!this.subscribeAccountAddresses.includes(holder.address)) {
          const holderPubkey = new PublicKey(holder.address)
          const holderAccountInfo = await web3Conn.getAccountInfo(holderPubkey)
          if (!holderAccountInfo) {
            throw Promise.reject(`null lp holder account ${holder.address}`)
          }

          const holderTokenInfo = decodeAccountTokenInfo(holderAccountInfo.data)
          this.holderAccounts.set(holder.address, holderTokenInfo)

          this.log.debug('holder fetched', {
            pair,
            address: holder.address,
            amount: holderTokenInfo.amount.toString()
          })

          // subscribe token to watch balance
          web3Conn.onAccountChange(
            holderPubkey,
            this.createTokenHolderChangedHandler(holder.address)
          )
          this.subscribeAccountAddresses.push(holder.address)
        }
      })
    )

    const pairHandler = new LpTokenPair(pair, this, submitterConf, subAggregatedFeeds)
    pairHandler.init()
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