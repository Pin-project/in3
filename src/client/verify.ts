import * as util from 'ethereumjs-util'
import * as Transaction from 'ethereumjs-tx'
import * as Trie from 'merkle-patricia-tree'
import { RPCRequest, RPCResponse } from '../types/config';
import { Signature } from '../types/config';
import Block, { toHex, createTx, BlockData, serializeReceipt, serializeAccount, toBuffer, promisify, LogData } from './block'
import { StringifyOptions } from 'querystring';
import * as request from 'request'
import { executeCall } from './call'


export interface LogProof {
  [blockNumber: string]: {
    block: string
    allReceipts?: any[]
    receipts: {
      [txHash: string]: {
        txIndex: number
        proof: string[]
      }
    }
  }
}
export interface Proof {
  type: 'transactionProof' | 'receiptProof' | 'blockProof' | 'accountProof' | 'nodeListProof' | 'callProof' | 'logProof'
  block?: string,
  merkelProof?: string[],
  transactions?: any[]
  logProof?: LogProof
  account?: AccountProof,
  accounts?: { [adr: string]: AccountProof },
  txIndex?,
  signatures: Signature[]
}

export interface AccountProof {
  accountProof: string[]
  address: string,
  balance: string
  codeHash: string
  code?: string
  nonce: string
  storageHash: string
  storageProof: {
    key: string
    proof: string[]
    value: string
  }[]
}


/** converts blockdata to a hexstring*/
export function blockToHex(block) {
  return new Block(block).serializeHeader().toString('hex')
}

/** converts a hexstring to a block-object */
export function blockFromHex(hex) {
  return new Block(hex)
}

/** verify the signatures of a blockhash */
export function verifyBlock(b: Block, signatures: Signature[], expectedSigners: string[], expectedBlockHash: string) {

  const blockHash = '0x' + b.hash().toString('hex').toLowerCase()
  if (expectedBlockHash && blockHash !== expectedBlockHash.toLowerCase())
    throw new Error('The BlockHash is not the expected one!')

  // TODO in the future we are not allowing block verification without signature
  if (!signatures) return

  const messageHash = util.sha3(blockHash + b.number.toString('hex').padStart(64, '0')).toString('hex')
  if (!signatures.filter(_ => _.block.toString(16) === b.number.toString('hex')).reduce((p, signature, i) => {
    if (messageHash !== signature.msgHash)
      throw new Error('The signature signed the wrong message!')
    const signer = '0x' + util.pubToAddress(util.erecover(messageHash, signature.v, util.toBuffer(signature.r), util.toBuffer(signature.s))).toString('hex')
    if (signer.toLowerCase() !== expectedSigners[i].toLowerCase())
      throw new Error('The signature was not signed by ' + expectedSigners[i])
    return true
  }, true))
    throw new Error('No valid signature')
}



/** creates the merkle-proof for a transation */
export async function createTransactionProof(block: BlockData, txHash: string, signatures: Signature[]): Promise<Proof> {
  // we always need the txIndex, since this is used as path inside the merkle-tree
  const txIndex = block.transactions.findIndex(_ => _.hash === txHash)
  if (txIndex < 0) throw new Error('tx not found')

  // create trie
  const trie = new Trie()
  // fill in all transactions
  await Promise.all(block.transactions.map(tx => new Promise((resolve, reject) =>
    trie.put(
      util.rlp.encode(parseInt(tx.transactionIndex)), // path as txIndex
      createTx(tx).serialize(),  // raw transactions
      error => error ? reject(error) : resolve(true)
    )
  )))

  // check roothash
  if (block.transactionsRoot !== '0x' + trie.root.toString('hex'))
    throw new Error('The transactionHash is wrong! : ' + block.transactionsRoot + '!==0x' + trie.root.toString('hex'))

  // create prove
  return new Promise<Proof>((resolve, reject) =>
    Trie.prove(trie, util.rlp.encode(txIndex), (err, prove) => {
      if (err) return reject(err)
      resolve({
        type: 'transactionProof',
        block: blockToHex(block),
        merkelProof: prove.map(_ => _.toString('hex')),
        txIndex, signatures
      })
    }))
}

/** creates the merkle-proof for a transation */
export async function createTransactionReceiptProof(block: BlockData, receipts: any[], txHash: string, signatures: Signature[]): Promise<Proof> {
  // we always need the txIndex, since this is used as path inside the merkle-tree
  const txIndex = block.transactions.indexOf(txHash)
  if (txIndex < 0)
    throw new Error('tx not found')

  // create trie
  const trie = new Trie()
  // fill in all transactions
  await Promise.all(receipts.map(tx => new Promise((resolve, reject) =>
    trie.put(
      util.rlp.encode(parseInt(tx.transactionIndex)), // path as txIndex
      serializeReceipt(tx),  // raw transactions
      error => error ? reject(error) : resolve(true)
    )
  )))

  // check roothash
  if (block.receiptsRoot !== '0x' + trie.root.toString('hex'))
    throw new Error('The receiptHash is wrong! : ' + block.receiptsRoot + '!==0x' + trie.root.toString('hex'))

  // create prove
  return new Promise<Proof>((resolve, reject) =>
    Trie.prove(trie, util.rlp.encode(txIndex), (err, prove) => {
      if (err) return reject(err)
      resolve({
        type: 'receiptProof',
        block: blockToHex(block),
        merkelProof: prove.map(_ => _.toString('hex')),
        txIndex, signatures
      })
    }))
}



/** verifies a TransactionProof */
export async function verifyTransactionProof(txHash: string, proof: Proof, expectedSigners: string[], txData: any) {

  if (!txData) throw new Error('No TransactionData!')

  // decode the blockheader
  const block = blockFromHex(proof.block)

  // verify the blockhash and the signatures
  verifyBlock(block, proof.signatures, expectedSigners, txData.blockHash)

  // TODO the from-address is not directly part of the hash, so manipulating this property would not be detected! 
  // we would have to take the from-address from the signature
  const txHashofData = '0x' + createTx(txData).hash().toString('hex')
  if (txHashofData !== txHash)
    throw new Error('The transactiondata were manipulated')

  return new Promise((resolve, reject) => {
    Trie.verifyProof(
      block.transactionsTrie, // expected merkle root
      util.rlp.encode(proof.txIndex), // path, which is the transsactionIndex
      proof.merkelProof.map(_ => util.toBuffer('0x' + _)), // array of Buffer with the merkle-proof-data
      (err, value) => { // callback
        if (err) return reject(err)
        // the value holds the Buffer of the transaction to proof
        // we can now simply hash this and compare it to the given txHas
        if (txHash === '0x' + util.sha3(value).toString('hex'))
          resolve(value)
        else
          reject(new Error('The TransactionHash could not be verified, since the merkel-proof resolved to a different hash'))
      })
  })


}


/** verifies a TransactionProof */
export async function verifyTransactionReceiptProof(txHash: string, proof: Proof, expectedSigners: string[], receipt: any) {

  if (!receipt) throw new Error('No TransactionData!')

  // decode the blockheader
  const block = blockFromHex(proof.block)

  // verify the blockhash and the signatures
  verifyBlock(block, proof.signatures, expectedSigners, receipt.blockHash)

  // since the blockhash is verified, we have the correct transaction root
  return new Promise((resolve, reject) => {
    Trie.verifyProof(
      block.receiptTrie, // expected merkle root
      util.rlp.encode(proof.txIndex), // path, which is the transsactionIndex
      proof.merkelProof.map(_ => util.toBuffer('0x' + _)), // array of Buffer with the merkle-proof-data
      (err, value) => { // callback
        if (err) return reject(err)
        // the value holds the Buffer of the transaction to proof
        // we can now simply hash this and compare it to the given txHas
        if (value.toString('hex') === serializeReceipt(receipt).toString('hex'))
          resolve(value)
        else
          reject(new Error('The TransactionHash could not be verified, since the merkel-proof resolved to a different hash'))
      })
  })


}



/** verifies a TransactionProof */
export async function verifyLogProof(proof: Proof, expectedSigners: string[], logs: LogData[]) {

  if (!logs) throw new Error('No Logs!')
  if (!logs.length) return

  if (!proof.logProof) throw new Error('Missing LogProof')

  const receiptData: { [txHash: string]: Buffer[] } = {}
  const blockHashes: { [blockNumber: string]: string } = {}

  await Promise.all(Object.keys(proof.logProof).map(async bn => {

    const blockProof = proof.logProof[bn]

    // decode the blockheader
    const block = blockFromHex(blockProof.block)
    blockHashes[bn] = '0x' + block.hash().toString('hex')

    // verify the blockhash and the signatures
    verifyBlock(block, proof.signatures, expectedSigners, null)

    // verifiy all merkle-Trees of the receipts
    await Promise.all(Object.keys(blockProof.receipts).map(txHash =>
      new Promise((resolve, reject) => {
        Trie.verifyProof(
          block.receiptTrie, // expected merkle root
          util.rlp.encode(toBuffer(blockProof.receipts[txHash].txIndex)), // path, which is the transsactionIndex
          blockProof.receipts[txHash].proof.map(_ => util.toBuffer('0x' + _)), // array of Buffer with the merkle-proof-data
          (err, value) => { // callback
            if (err) return reject(err)
            resolve(receiptData[txHash] = value)
          })
      })
    ))

  }))


  // now verify the logdata
  logs.forEach(l => {
    const receipt = receiptData[l.transactionHash]
    if (!receipt) throw new Error('The receipt ' + l.transactionHash + 'is missing in the proof')

    const logData = (receipt[3] as any)[parseInt(l.logIndex)] as Buffer[]
    if (!logData) throw new Error('Log not found in Transaction')

    /// txReceipt.logs.map(l => [l.address, l.topics.map(toBuffer), l.data].map(toBuffer))]
    if (logData[0].toString('hex') !== l.address.toLowerCase().substr(2))
      throw new Error('Wrong address in log ')

    if ((logData[1] as any as Buffer[]).map(toHex).join() !== l.topics.join())
      throw new Error('Wrong Topics in log ')

    if (util.rlp.encode(logData[2]).toString('hex') !== l.data.substr(2))
      throw new Error('Wrong data in log ')

    const bp = proof.logProof[toHex(l.blockNumber)]
    if (bp)
      throw new Error('wrong blockNumber')

    if (blockHashes[toHex(l.blockNumber)] !== l.blockHash)
      throw new Error('wrong blockhash')

    if (!bp.receipts[l.transactionHash])
      throw new Error('wrong transactionHash')

    if (bp.receipts[l.transactionHash].txIndex !== parseInt(l.transactionIndex as string))
      throw new Error('wrong transactionIndex')
  })
}



/** verifies a TransactionProof */
export async function verifyBlockProof(request: RPCRequest, data: any, proof: Proof, expectedSigners: string[]) {
  // decode the blockheader
  const block = new Block(proof.block || data)
  if (proof.transactions) block.transactions = proof.transactions.map(createTx)

  let requiredHash = null

  if (request.method.endsWith('ByHash'))
    requiredHash = request.params[0]
  else if (parseInt(request.params[0]) && parseInt(request.params[0]) !== parseInt('0x' + block.number.toString('hex')))
    throw new Error('The Block does not contain the required blocknumber')
  if (!requiredHash && request.method.indexOf('Count') < 0 && data)
    requiredHash = toHex(data.hash)

  // verify the blockhash and the signatures
  verifyBlock(block, proof.signatures, expectedSigners, requiredHash)

  // verify the transactions
  if (block.transactions) {
    const trie = new Trie()
    await Promise.all(block.transactions.map((tx, i) =>
      promisify(trie, trie.put, util.rlp.encode(i), tx.serialize())
    ))
    var txT = block.transactionsTrie.toString('hex')
    const thash = block.transactions.length ? trie.root.toString('hex') : util.SHA3_RLP.toString('hex')
    if (thash !== block.transactionsTrie.toString('hex'))
      throw new Error('The Transaction of do not hash to the given transactionHash!')
  }

  if (request.method.indexOf('Count') > 0 && toHex(block.transactions.length) != toHex(data))
    throw new Error('The number of transaction does not match')
}



/** verifies a TransactionProof */
export async function verifyAccountProof(request: RPCRequest, value: string, proof: Proof, expectedSigners: string[]) {
  if (!value) throw new Error('No Accountdata!')

  // verify the result
  if (request.params[0].toLowerCase() !== proof.account.address.toLowerCase()) throw new Error('The Account does not match the account in the proof')
  switch (request.method) {
    case 'eth_getBalance':
      if (value !== proof.account.balance) throw new Error('The Balance does not match the one in the proof')
      break
    case 'eth_getStorageAt':
      const entry = proof.account.storageProof.find(_ => toHex(_.key) === toHex(request.params[1]))
      if (!entry) throw new Error('The proof for the storage value ' + request.params[1] + ' can not be found ')
      if (toHex(entry.value) !== toHex(value)) throw new Error('The Value does not match the one in the proof')
      break
    case 'eth_getCode':
      if (proof.account.codeHash !== '0x' + util.keccak(value).toString('hex')) throw new Error('The codehash in the proof does not match the code')
      break
    case 'eth_getTransactionCount':
      if (proof.account.nonce !== value) throw new Error('The nonce in the proof does not match the returned')
      break
    default:
      throw new Error('Unsupported Account-Proof for ' + request.method)
  }

  // verify the blockhash and the signatures
  const block = new Block(proof.block)
  // TODO if we expect a specific block in the request, we should also check if the block is the one requested
  verifyBlock(block, proof.signatures, expectedSigners, null)

  // verify the merkle tree of the account proof
  await verifyAccount(proof.account, block)
}


/** verifies a TransactionProof */
export async function verifyCallProof(request: RPCRequest, value: string, proof: Proof, expectedSigners: string[]) {

  // verify the blockhash and the signatures
  const block = new Block(proof.block)
  // TODO if we expect a specific block in the request, we should also check if the block is the one requested
  verifyBlock(block, proof.signatures, expectedSigners, null)

  if (!proof.accounts) throw new Error('No Accounts to verify')

  // verify all accounts
  await Promise.all(Object.keys(proof.accounts).map(adr => verifyAccount(proof.accounts[adr], block)))

  // now create a vm and run the transaction
  const result = await executeCall(request.params[0], proof.accounts)

  if (result !== value)
    throw new Error('The result does not match the execution !')

}










function verifyAccount(accountProof: AccountProof, block: Block) {

  // if we received the code, make sure the codeHash is correct!
  if (accountProof.code && util.keccak(accountProof.code).toString('hex') !== accountProof.codeHash.substr(2))
    throw new Error('The code does not math the correct codehash! ')

  return Promise.all([
    // verify the account
    new Promise((resolve, reject) => {
      Trie.verifyProof(
        block.stateRoot, // expected merkle root
        util.keccak(accountProof.address), // path, which is the transsactionIndex
        accountProof.accountProof.map(util.toBuffer), // array of Buffer with the merkle-proof-data
        (err, value) => { // callback
          if (err) return reject(err)

          // encode the account
          const account = serializeAccount(accountProof.nonce, accountProof.balance, accountProof.storageHash, accountProof.codeHash)

          if (value.toString('hex') === account.toString('hex'))
            resolve(value)
          else
            reject(new Error('The Account could not be verified, since the merkel-proof resolved to a different hash'))

        })
    }),

    // and all storage proofs
    ...accountProof.storageProof.map(s =>
      new Promise((resolve, reject) =>
        Trie.verifyProof(
          toBuffer(accountProof.storageHash),   // the storageRoot of the account
          util.keccak(toHex(s.key, 32)),  // the path, which is the hash of the key
          s.proof.map(util.toBuffer), // array of Buffer with the merkle-proof-data
          (err, value) => { // callback
            if (err) return reject(err)
            if ('0x' + value.toString('hex') === toHex(s.value))
              resolve(value)
            else
              reject(new Error('The storage value for ' + s.key + ' could not be verified, since the merkel-proof resolved to a different hash'))

          })
      ))
  ])
}

/** general verification-function which handles it according to its given type. */
export async function verifyProof(request: RPCRequest, response: RPCResponse, allowWithoutProof = true, throwException = true): Promise<boolean> {
  const proof = response && response.in3 && response.in3.proof as any as Proof
  if (!proof) {
    if (throwException && !allowWithoutProof) throw new Error('the response does not contain any proof!')
    return allowWithoutProof
  }
  try {
    switch (proof.type) {
      case 'nodeListProof':
        // TODO implement proof for nodelist
        //        await verifyTransactionProof(request.params[0], proof, request.in3 && request.in3.signatures, response.result && response.result as any)
        break
      case 'transactionProof':
        await verifyTransactionProof(request.params[0], proof, request.in3 && request.in3.signatures, response.result && response.result as any)
        break
      case 'logProof':
        await verifyLogProof(proof, request.in3 && request.in3.signatures, response.result && response.result as LogData[])
        break
      case 'receiptProof':
        await verifyTransactionReceiptProof(request.params[0], proof, request.in3 && request.in3.signatures, response.result && response.result as any)
        break
      case 'blockProof':
        await verifyBlockProof(request, response.result as any, proof, request.in3 && request.in3.signatures)
        break
      case 'accountProof':
        await verifyAccountProof(request, response.result as string, proof, request.in3 && request.in3.signatures)
        break
      case 'callProof':
        await verifyCallProof(request, response.result as string, proof, request.in3 && request.in3.signatures)
        break
      default:
        throw new Error('Unsupported proof-type : ' + proof.type)
    }
    return true
  }
  catch (ex) {
    if (throwException) throw ex
    return false
  }
}




// converts a string into a Buffer, but treating 0x00 as empty Buffer
const toVariableBuffer = (val: string) => (val == '0x' || val === '0x0' || val === '0x00') ? Buffer.alloc(0) : util.toBuffer(val) as Buffer

