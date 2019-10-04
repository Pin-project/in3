/*******************************************************************************
 * This file is part of the Incubed project.
 * Sources: https://github.com/slockit/in3
 * 
 * Copyright (C) 2018-2019 slock.it GmbH, Blockchains LLC
 * 
 * 
 * COMMERCIAL LICENSE USAGE
 * 
 * Licensees holding a valid commercial license may use this file in accordance 
 * with the commercial license agreement provided with the Software or, alternatively, 
 * in accordance with the terms contained in a written agreement between you and 
 * slock.it GmbH/Blockchains LLC. For licensing terms and conditions or further 
 * information please contact slock.it at in3@slock.it.
 * 	
 * Alternatively, this file may be used under the AGPL license as follows:
 *    
 * AGPL LICENSE USAGE
 * 
 * This program is free software: you can redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License as published by the Free Software 
 * Foundation, either version 3 of the License, or (at your option) any later version.
 *  
 * This program is distributed in the hope that it will be useful, but WITHOUT ANY 
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A 
 * PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.
 * [Permissions of this strong copyleft license are conditioned on making available 
 * complete source code of licensed works and modifications, which include larger 
 * works using a licensed work, under the same license. Copyright and license notices 
 * must be preserved. Contributors provide an express grant of patent rights.]
 * You should have received a copy of the GNU Affero General Public License along 
 * with this program. If not, see <https://www.gnu.org/licenses/>.
 *******************************************************************************/

import ChainContext from '../../client/ChainContext'
import { ChainSpec, RPCRequest, RPCResponse } from '../../types/types';
import Client from '../../client/Client';
import Filters from './filter'

import { serialize, util } from 'in3-common';
import { keccak } from 'ethereumjs-util'
const Buffer: any = require('buffer').Buffer


export default class EthChainContext extends ChainContext {
  codeCache: CacheNode
  blockCache: { number: number, header: Buffer, hash: Buffer }[]
  filters: Filters

  constructor(client: Client, chainId: string, chainSpec: ChainSpec[]) {
    super(client, chainId, chainSpec)
    this.filters = new Filters()
  }

  handleIntern(request: RPCRequest): Promise<RPCResponse> {
    return this.filters.handleIntern(request, this.client)
  }


  async getCodeFor(addresses: Buffer[], block = 'latest'): Promise<Buffer[]> {
    const result = addresses.map(a => this.codeCache.get(a))
    const missing: RPCRequest[] = result.map((_, i) => _ ? null : { method: 'eth_getCode', params: [util.toHex(addresses[i], 20), block[0] === 'l' ? block : util.toMinHex(block)], id: i + 1, jsonrpc: '2.0' as any }).filter(_ => _)
    if (missing.length) {
      for (const r of await this.client.send(missing, undefined, { proof: 'none', signatureCount: 0, chainId: this.chainId }) as RPCResponse[]) {
        const i = r.id as number - 1
        if (r.error) throw new Error(' could not get the code for address ' + addresses[i] + ' : ' + r.error)
        this.codeCache.put(addresses[i], serialize.bytes(result[i] = r.result))
      }
      if (this.client.defConfig.cacheStorage && this.chainId)
        this.client.defConfig.cacheStorage.setItem('in3.code.' + this.chainId, this.codeCache.toStorage())

    }

    return result
  }

  getLastBlockHashes() {
    return this.blockCache.map(_ => util.toHex(_.hash))
  }

  getBlockHeader(blockNumber: number): Buffer {
    const b = this.blockCache.length && this.blockCache.find(_ => _.number === blockNumber)
    return b ? b.header : null
  }

  getBlockHeaderByHash(blockHash: Buffer): Buffer {
    const b = this.blockCache.length && this.blockCache.find(_ => _.hash.equals(blockHash))
    return b ? b.header : null
  }

  addBlockHeader(blockNumber: number, header: Buffer) {
    if (!this.client.defConfig.maxBlockCache || header.equals(this.getBlockHeader(blockNumber) || Buffer.allocUnsafe(0))) return header
    while (this.blockCache.length >= this.client.defConfig.maxBlockCache && this.blockCache.length)
      this.blockCache.splice(this.blockCache.reduce((p, c, i, a) => c.number < a[i].number ? i : p, 0), 1)

    this.blockCache.push({ number: blockNumber, header, hash: keccak(header) })
    this.client.defConfig.verifiedHashes = this.getLastBlockHashes()
    return header
  }


  initCache() {
    super.initCache()
    this.codeCache = new CacheNode(this.client.defConfig.maxCodeCache || 100000)
    this.blockCache = []
    const chainId = this.chainId;
    if (this.client.defConfig.cacheStorage && chainId) {
      // read codeCache
      const codeCache = this.client.defConfig.cacheStorage.getItem('in3.code.' + chainId)
      try {
        if (codeCache)
          this.codeCache.fromStorage(codeCache)
      }
      catch (ex) {
        this.client.defConfig.cacheStorage.setItem('in3.code.' + chainId, '')
      }
    }
  }

}

export interface CacheEntry {
  added: number
  data: Buffer
}

export class CacheNode {

  limit: number

  data: Map<string, CacheEntry>
  dataLength: number

  constructor(limit: number) {
    this.limit = limit
    this.dataLength = 0
    this.data = new Map()
  }

  get(key: Buffer): Buffer {
    const entry = this.data.get(key.toString('hex'))
    return entry ? entry.data : null
  }

  put(key: Buffer, val: Buffer) {
    const old = this.get(key)
    if (old) {
      this.dataLength -= this.getByteLength(old)
      this.data.delete(key.toString('hex'))
    }
    const size = this.getByteLength(val)
    while (this.limit && !old && this.dataLength + size >= this.limit) {
      let oldestKey = null
      let oldestVal = { added: Date.now(), data: null }
      for (const [k, v] of this.data.entries()) {
        if (v.added < oldestVal.added) {
          oldestVal = v
          oldestKey = k
        }
      }
      if (!oldestKey) break
      this.data.delete(oldestKey)
      this.dataLength -= this.getByteLength(oldestVal.data)
    }
    this.data.set(key.toString('hex'), { added: Date.now(), data: val })
    this.dataLength += this.getByteLength(val)
  }

  getByteLength(entry: Buffer | string) {
    if (Buffer.isBuffer(entry)) return entry.length
    if (typeof entry === 'string') return entry.length * 2
    return 4
  }

  toStorage() {
    const entries = []
    this.data.forEach((val, key) => {
      entries.push(Buffer.from(key, 'hex'))
      entries.push(val.data)
    })
    return serialize.rlp.encode(entries).toString('base64')
  }

  fromStorage(data: string) {
    const entries: Buffer[] = serialize.rlp.decode(Buffer.from(data, 'base64')) as Buffer[]
    for (let i = 0; i < entries.length; i += 2)
      this.put(entries[i], entries[i + 1])
  }

}
