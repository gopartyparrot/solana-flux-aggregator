import fs from 'fs'
import path from 'path';
import { FeedSource } from '../../config'
import { log } from '../../log'
import { sleep } from '../../utils';
import { IPrice, PriceFeed } from '../PriceFeed'

/** FilePriceFeed read price data from json file, for test or emergency feed */
export class FileSource extends PriceFeed {
    public source = FeedSource.FILE;
    protected log = log.child({ class: this.source })
    protected baseurl = "unused"
  
    constructor(public tickMillisecond: number, protected baseDir: string) {
      super();
    }
  
    async init() {
      this.startPollingFiles();//background task
    }
  
    async startPollingFiles() {
      while (true) {
        for (let pair of this.pairs) {
          let prefix = pair.replace('/', '_').replace(':', '_');
          let filename = path.join(this.baseDir, `${prefix}.json`);
          try {
            fs.accessSync(filename, fs.constants.R_OK)
            let price = JSON.parse(fs.readFileSync(filename, 'utf8')); //TODO validate
            price.time = Date.now();
            this.onMessage(price);
          } catch (e) {
            //no permission to read or file not exists, or file content err
            this.log.error('Read price feed file err', e);
            continue
          }
        }
        await sleep(this.tickMillisecond);
      }
    }
  
    //unused for file price feed
    parseMessage(data: any): IPrice | undefined { return undefined; }
    //unused for file price feed
    handleSubscribe(pair: string): Promise<void> { return Promise.resolve(); }
  }
  