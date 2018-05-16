import Client from './Client'
import { simpleEncode, simpleDecode } from 'ethereumjs-abi'
import { toBuffer, toChecksumAddress } from 'ethereumjs-util'
import { toHex } from './block'


export async function callContract(client: Client, contract: string, chainId: string, signature: string, args: any[]) {
  return simpleDecode(signature, toBuffer(await client.call({
    method: 'eth_call', params: [{
      to: contract,
      data: '0x' + simpleEncode(signature, ...args).toString('hex')
    },
      'latest']
  } as any, { chainId })))
}

export async function getChainData(client: Client, chainId: string) {
  return callContract(client, client.defConfig.chainRegistry, client.defConfig.mainChain, 'chains(bytes32):(address,string,string,address,bytes32)', [toHex(chainId, 32)]).then(_ => ({
    owner: toChecksumAddress(_[0]) as string,
    bootNodes: _[1].split(',') as string[],
    meta: _[2] as string,
    registryContract: toChecksumAddress(_[3]) as string,
    contractChain: toSimpleHex(toHex(_[4])) as string
  }))
}


function toSimpleHex(val: string) {
  let hex = val.replace('0x', '')
  while (hex.startsWith('00') && hex.length > 2)
    hex = hex.substr(2)
  return '0x' + hex

}