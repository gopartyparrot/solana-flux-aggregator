import fs from "fs"

function loadJSON(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

const aggregatorConfigDefaults: Partial<AggregatorSetupConfig> = {
  decimals: 0,
  minSubmissions: 0,
  maxSubmissions: 1,
  restartDelay: 0,
  rewardAmount: 0,
}

export function loadAggregatorSetup(file: string): AggregatorSetupFile {
  let obj: AggregatorSetupFile = loadJSON(file)

  for (let key of Object.keys(obj.aggregators)) {
    obj.aggregators[key] = {
      ...aggregatorConfigDefaults,
      ...obj.aggregators[key],
    }
  }
  return obj
}

export interface OracleConfig {
  owner: string
}

export interface RequesterConfig {
  owner: string
}

export interface AggregatorSetupConfig {
  decimals: number
  minSubmissions: number
  maxSubmissions: number
  roundTimeout: number
  restartDelay: number
  requesterRestartDelay: number
  rewardAmount: number
  rewardTokenAccount?: string

  oracles?: string[]
  requesters?: string[]
}

export interface AggregatorSetupFile {
  programID: string

  aggregators: {
    [key: string]: AggregatorSetupConfig
  }
  oracles: {
    [key: string]: OracleConfig
  }
  requesters: {
    [key: string]: RequesterConfig
  }
}

export function loadSolinkConfig(file: string): SolinkConfig {
  let obj: SolinkConfig = loadJSON(file)
  return obj
}

export interface SolinkConfig {
  priceFileDir?: string //directory where price files layout, if not provided process.cwd() used
  submitter: {
    [key: string]: SolinkSubmitterConfig //key: pair name (eg: btc:usd)
    default: SolinkSubmitterConfig //if no SubmitterConfig provided for pair, default is used
  }
}

export interface SolinkLpTokenHolderConfig {
  address: string
  symbol?: string
  // oracle: string
  feed: {
    name: string
    config?: SolinkSubmitterConfig
  }
  decimals: number
}

export interface SolinkSerumConfig {
  marketAddress: string
  feed: {
    name: string
    config?: SolinkSubmitterConfig
  }
  decimals: number
}

interface SolinkLpTokenSubmitterConfig {
  lpTokenAddress: string
  version: number
  ammId: string
  ammOpenOrders: string
  serumProgramId: string
  holders: {
    base: SolinkLpTokenHolderConfig,
    quote: SolinkLpTokenHolderConfig
  }
  decimals: number
}

export interface SolinkSubmitterConfig {
  source?: FeedSource[]
  additionalSources?: FeedSource[]
  priceMint?: string
  relativeTo?: string
  useEwma?: boolean
  inverse?: boolean
  lpToken?: SolinkLpTokenSubmitterConfig
  serum?: SolinkSerumConfig
  lastUpdateTimeout?: number
  minValueChangeForNewRound: number
}

export enum FeedSource {
  COINBASE = "coinbase",
  COINBASE_INVERSE = "coinbase_inverse",
  FTX = "ftx",
  GOPRICES = "goprices",
  FTX_INVERSE = 'ftx_inverse',
  BITSTAMP = "bitstamp",
  BINANCE = "binance",
  BINANCE_INVERSE = "binance_inverse",
  OKEX = "okex",
  LPTOKEN = "lptoken",
  SERUM = "serum",
  FILE = "file",
}
