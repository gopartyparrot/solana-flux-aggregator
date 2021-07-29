import { PublicKey, Wallet } from "solray"
import { conn } from "./context"
import { Aggregator, Submissions, Oracle } from "./schema"
import BN from "bn.js"
import { getAccounts, parseTransactionError, retryOperation } from "./utils"
import FluxAggregator from "./FluxAggregator"
import {  Logger } from "winston"
import { log } from "./log"
import axios from "axios"
import { ErrorNotifier } from "./ErrorNotifier"
import { metricOracleFeedPrice, metricOracleLastSubmittedPrice, metricOracleSinceLastSubmitSeconds, metricOracleSubmitRetryCount } from "./metrics"
import { IPriceFeed } from "./feeds/PriceFeed"

// allow oracle to start a new round after this many slots. each slot is about 500ms
const MAX_ROUND_STALENESS = 10

export interface SubmitterConfig {
  // won't start a new round unless price changed this much
  minValueChangeForNewRound: number,
  // symbol for this aggregator (eg. btc:usd)
  pairSymbol: string,
  chainlink?: {
    // chainlink node url
    nodeURL: string,
    // chainlink external initiator jobId
    nodeEIJobID: string,
    // chainlink external initiator access key
    nodeEIAccessKey: string,
    // chainlink external initiator secret key
    nodeEISecret: string,
  }
}

export class Submitter {
  public aggregator!: Aggregator
  public oracle!: Oracle
  public roundSubmissions!: Submissions
  public answerSubmissions!: Submissions
  public program: FluxAggregator
  public logger!: Logger
  public currentValue: BN
  public currentValueUpdatedAt: number
  public previousRound: BN
  public reportedRound: BN
  public lastSubmittedAt: number

  static ValueExpireTime = 60000 * 5 // 5mins

  constructor(
    programID: PublicKey,
    public aggregatorPK: PublicKey,
    public oraclePK: PublicKey,
    private oracleOwnerWallet: Wallet,
    private errorNotifier: ErrorNotifier,
    private priceFeed: IPriceFeed,
    private cfg: SubmitterConfig,
    private getSlot: () => number
  ) {
    this.program = new FluxAggregator(this.oracleOwnerWallet, programID)
    this.currentValue = new BN(0)
    this.currentValueUpdatedAt = 0
    this.previousRound = new BN(0)
    this.reportedRound = new BN(0)
    this.lastSubmittedAt = Date.now()
  }

  public async start() {
    await this.reloadStates()

    this.logger = log.child({
      oracle: this.oracle.description,
      aggregator: this.aggregator.config.description,
    })

    await this.observeAggregatorState()
    await this.observePriceFeed()
  }

  // TODO: harvest rewards if > n
  public async withdrawRewards() {
    // if (this.oracle.withdrawable.isZero()) {
    //   return
    // }
    // //
    // this.program.withdraw({
    //   accounts: {
    //     aggregator: this.aggregatorPK,
    //     // faucet
    //   }
    // })
  }

  private async reloadStates()  {
    try {
      if (!this.aggregator) {
        this.aggregator = await Aggregator.load(this.aggregatorPK)
      }

      const [
        oracle,
        roundSubmissions,
        answerSubmissions,
      ] = await getAccounts(conn, [
        this.oraclePK,
        this.aggregator.roundSubmissions,
        this.aggregator.answerSubmissions,
      ])

      this.oracle = Oracle.deserialize(oracle.data)
      this.answerSubmissions = Submissions.deserialize(answerSubmissions.data)
      this.roundSubmissions = Submissions.deserialize(roundSubmissions.data)
    } catch(err) {      
      if(this.logger) {
        this.logger.error(`Error in ReloadStates`, err)
      } else {
        log.error(`Error in ReloadStates`, err)
      }
    }
  }

  private isRoundReported(roundID: BN): boolean {
    return !roundID.isZero() && roundID.lte(this.reportedRound)
  }

  private async observeAggregatorState() {
    conn.onAccountChange(this.aggregatorPK, async (info) => {
      this.aggregator = Aggregator.deserialize(info.data)

      if (this.isRoundReported(this.aggregator.round.id)) {
        return
      }

      // only update states if actually reporting to save RPC calls
      await this.reloadStates()
      this.onAggregatorStateUpdate()
    })
  }

  private async observePriceFeed() {
    for await (let price of this.priceFeed) {      
      if (price.decimals != this.aggregator.config.decimals) {
        throw new Error(
          `Expect price with decimals of ${this.aggregator.config.decimals} got: ${price.decimals}`
        )
      }

      try {
        // Do not submit price older then 5 minutes
        this.currentValue = new BN(price.value)
        this.currentValueUpdatedAt = price.time

        metricOracleFeedPrice.set(
          {
            submitter: this.oracle.description,
            feed: price.pair,
            source: price.source
          },
          price.value / 10 ** price.decimals
        )

        const now = Date.now()
        const lastSubmit = now - this.lastSubmittedAt
        metricOracleSinceLastSubmitSeconds.set(
          {
            submitter: this.oracle.description,
            feed: this.aggregator.config.description
          },
          Math.floor(lastSubmit / 1000)
        )

        const valueDiff = this.aggregator.answer.median
          .sub(this.currentValue)
          .abs()

        if (valueDiff.lt(new BN(this.cfg.minValueChangeForNewRound))) {
          this.logger.debug("price did not change enough to start a new round", {
            diff: valueDiff.toNumber(),
          })
          continue
        }

        if (!this.isRoundReported(this.aggregator.round.id)) {
          // should reload the state if no round is reported
          await this.reloadStates()
        }

        await this.trySubmit()

      } catch (err) {
        this.reportedRound = this.previousRound
        this.reloadStates()
        this.logger.error(`Error in ObservePriceFeed`, { 
          error: `${err}`, 
          feed: this.aggregator.config.description,
          median: this.aggregator.answer.median.toString(), 
          currentValue: this.currentValue.toString(), 
        })
      }
    }
  }

  private async trySubmit() {
    this.logger.debug("oracle", { oracle: this.oracle })

    const { round } = this.aggregator

    if (this.canSubmitToCurrentRound) {
      await this.submitCurrentValue(round.id)
      return
    }

    // or, see if oracle can start a new round
    const sinceLastUpdate = new BN(this.getSlot()).sub(round.updatedAt)
    if (sinceLastUpdate.ltn(MAX_ROUND_STALENESS)) {
      // round is not stale yet. don't submit new round
      return
    }    

    // The round is stale. start a new round if possible, or wait for another
    // oracle to start
    if (this.oracle.canStartNewRound(round.id)) {
      let newRoundID = round.id.addn(1)
      this.logger.info("Oracle Starting a new round", {
        round: newRoundID.toString(),
      })
      return this.submitCurrentValue(newRoundID)
    }
  }

  private async onAggregatorStateUpdate() {
    this.logger.debug("state updated", {
      aggregator: this.aggregator,
      submissions: this.roundSubmissions,
      answerSubmissions: this.answerSubmissions,
    })

    if (!this.canSubmitToCurrentRound) {
      return
    }

    this.logger.info("Another oracle started a new round", {
      round: this.aggregator.round.id.toString(),
    })
    await this.trySubmit()
  }

  get canSubmitToCurrentRound(): boolean {
    return this.roundSubmissions.canSubmit(
      this.oraclePK,
      this.aggregator.config
    )
  }

  private async createChainlinkSubmitRequest(roundID: BN) {
    if(!this.cfg.chainlink) {
      return
    }

    try {
      await axios.post(`${this.cfg.chainlink.nodeURL}/v2/specs/${this.cfg.chainlink.nodeEIJobID}/runs`, JSON.stringify({
          round: roundID.toString(),
          aggregator: this.aggregatorPK.toBase58(),
          pairSymbol: this.cfg.pairSymbol,
        }), {
          headers: {
            'Content-Type': 'application/json',
            'X-Chainlink-EA-AccessKey': this.cfg.chainlink.nodeEIAccessKey,
            'X-Chainlink-EA-Secret': this.cfg.chainlink.nodeEISecret,
          }
        })
    } catch(error) {
      this.logger.error('response', error)
    }
  }

  private async submitCurrentValue(roundID: BN) {
    const now = Date.now()
    // guard zero value
    if (this.currentValue.isZero()) {
      this.logger.warn("current value is zero. skip submit")
      return
    }
    
    if (now - this.currentValueUpdatedAt > Submitter.ValueExpireTime) {
      this.logger.warn(
        `current value has expired ${
          (now - this.currentValueUpdatedAt) / 1000
        }s. skip submit`
      )
      return
    }

    if (this.isRoundReported(roundID)) {
      this.logger.warn("don't report to the same round twice")
      return
    }

    // Set reporting round to avoid report twice
    // We also save the previousRound in case we fail to report this round, we will rollback and try again
    // NOTE: by setting the reportedRound here, we avoid to create a Chainlink Submit Request twice
    this.previousRound = this.reportedRound
    this.reportedRound = roundID

    this.logger.info("Submit to current round", { round: roundID.toString() })

    if (this.cfg.chainlink) {
      // prevent async race condition where submit could be called twice on the same round
      return this.createChainlinkSubmitRequest(roundID)
    }

    return this.submitCurrentValueImpl(roundID)
  }

  async submitCurrentValueImpl(roundID: BN){
    const value = this.currentValue

    this.logger.info("Submitting value", {
      round: roundID.toString(),
      value: value.toString(),
    })

    let txId = ''
    try {
      return await retryOperation(async (retryCount) => {
          try {
            txId =  await this.program.submit({
              accounts: {
                aggregator: { write: this.aggregatorPK },
                roundSubmissions: { write: this.aggregator.roundSubmissions },
                answerSubmissions: { write: this.aggregator.answerSubmissions },
                oracle: { write: this.oraclePK },
                oracle_owner: this.oracleOwnerWallet.account,
              },
              round_id: roundID,
              value,
            })

            // check if this round submission is confirmed, if not, resubmit this round
            const res = await conn.confirmTransaction(txId)
            if(res.value.err) {
              throw res.value.err
            }

            metricOracleLastSubmittedPrice.set( {
                submitter: this.oracle.description,
                feed: this.aggregator.config.description,
              }, value.toNumber() / 10 ** this.aggregator.config.decimals)

            this.reloadStates()

            this.logger.info("Submit OK", {
              round: roundID.toString(),
              value: value.toString(),
              withdrawable: this.oracle.withdrawable.toString(),
              rewardToken: this.aggregator.config.rewardTokenAccount.toString(),
              retryCount,
            })

            this.lastSubmittedAt = Date.now()
            metricOracleSinceLastSubmitSeconds.set({
                submitter: this.oracle.description,
                feed: this.aggregator.config.description,
              }, 0)

            return {
              roundID,
              currentValue: value,
            }
          } catch (err) {
            this.logger.info(`Submit confirmed failed`, {
              round: roundID.toString(),
              value: value.toString(),
              err: err.toString(),
              retryCount
            })
            // Check error and see if need to retry or we can ignore this error
            switch (parseTransactionError(err)) {
              case '6':
              case '3':
                // do not retry for this errors, do not throw err but reload the states to get new roundID
                this.reportedRound = this.previousRound
                this.reloadStates()
                this.errorNotifier.notifySoft('Submitter', `Each oracle may only submit once per round`, {
                    round: roundID.toString(),
                    aggregator: this.aggregator.config.description,
                    oracle: this.oraclePK.toString(),
                    txId,
                  }, err)
                break
              default:
                metricOracleSubmitRetryCount.labels(
                  this.oracle.description, 
                  this.aggregator.config.description
                ).inc();
                throw err
            }
          }
        }, 15000, 4)
    } catch (err) {
      this.reportedRound = this.previousRound
      this.reloadStates()
      this.logger.error("Submit error", {
        round: roundID.toString(),
        value: value.toString(),
        aggregator: this.aggregator.config.description,
        oracle: this.oraclePK.toString(),
        err: err.toString(),
        txId,
      })
      this.errorNotifier.notifyCritical('Submitter', `Oracle fail to submit a round`, {
          round: roundID.toString(),
          aggregator: this.aggregator.config.description,
          oracle: this.oraclePK.toString(),
          txId,
        }, err)
    }
  }
}
