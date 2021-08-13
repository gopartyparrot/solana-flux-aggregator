import { PublicKey, AccountInfo } from '@solana/web3.js'
import assert from 'assert'

import { FeedSource, SolinkSubmitterConfig } from '../../../config'
import { log } from '../../../log'
import { conn as web3Conn } from '../../../context'
import { IPrice, PriceFeed, SubAggregatedFeeds } from '../../PriceFeed'
import { Aggregator } from '../../../schema'
import { LpTokenPair } from './lpTokenPair'
import { BNu64, MINT_LAYOUT, TOKEN_ACCOUNT_LAYOUT } from './layout'

export const ACCOUNT_CHANGED = 'ACCOUNT_CHANGED'
const STABLE_ORACLE = 'STABLE'

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

export class LpToken extends PriceFeed {
  public source = FeedSource.LPTOKEN
  public decimals = 2
  public log = log.child({ class: this.source })

  protected baseurl = 'unused'
  private lpTokenAccounts = new Map<string, MintInfo>()
  private holderAccounts = new Map<string, TokenAccount>()
  private subscribeAccountAddresses: string[] = []

  public getLpTokenAccount(address: string) {
    return this.lpTokenAccounts.get(address)
  }

  public getHolderAccount(address: string) {
    return this.holderAccounts.get(address)
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

    await Promise.all(
      submitterConf.lpToken.holders.map(async holder => {
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

function extractAggregator(data: Buffer): oraclePrice {
  const info = Aggregator.deserialize<Aggregator>(data)
  return {
    price: info.answer.median.toNumber(),
    decimals: info.config.decimals
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
