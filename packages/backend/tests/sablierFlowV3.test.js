import { Interface } from 'ethers'
import { describe, expect, it } from 'vitest'
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_SABLIER_FLOW_V3, createBaseSepoliaFlowVerifier, createSablierFlowV3Decoder } from '../lib/payments/sablierFlowV3.js'

const token = '0x1111111111111111111111111111111111111111'
const sender = '0x2222222222222222222222222222222222222222'
const recipient = '0x3333333333333333333333333333333333333333'
const creator = '0x4444444444444444444444444444444444444444'
const flowInterface = new Interface(['event CreateFlowStream(uint256 streamId,address creator,address indexed sender,address indexed recipient,uint128 ratePerSecond,uint40 snapshotTime,address indexed token,bool transferable)'])

function logFor(address = BASE_SEPOLIA_SABLIER_FLOW_V3) {
  const encoded = flowInterface.encodeEventLog(flowInterface.getEvent('CreateFlowStream'), [42n, creator, sender, recipient, 1000000000000000n, 1n, token, false])
  return { address, topics: encoded.topics, data: encoded.data, transactionHash: `0x${'a'.repeat(64)}`, blockNumber: 100, blockHash: `0x${'b'.repeat(64)}`, index: 0 }
}

describe('Sablier Flow v3 Base Sepolia adapter', () => {
  it('decodes the verified CreateFlowStream event into PayTray evidence', async () => {
    const event = await createSablierFlowV3Decoder()(logFor())
    expect(event).toMatchObject({ type: 'stream_created', finalityStatus: 'included', streamProtocolId: '42', chainId: 84532, tokenAddress: token, senderWallet: sender, recipientWallet: recipient, amountBaseUnits: '1000000000000000' })
  })

  it('ignores logs from a different contract and unsupported subsequent events', async () => {
    expect(await createSablierFlowV3Decoder()(logFor('0x5555555555555555555555555555555555555555'))).toBeNull()
    const pauseInterface = new Interface(['event PauseFlowStream(uint256 indexed streamId,address indexed sender,address indexed recipient,uint256 totalDebt)'])
    const encoded = pauseInterface.encodeEventLog(pauseInterface.getEvent('PauseFlowStream'), [42n, sender, recipient, 1n])
    expect(await createSablierFlowV3Decoder()({ ...logFor(), topics: encoded.topics, data: encoded.data })).toBeNull()
  })

  it('hydrates a non-creation event from the durable stream context', async () => {
    const depositInterface = new Interface(['event DepositFlowStream(uint256 indexed streamId,address indexed funder,uint128 amount)'])
    const encoded = depositInterface.encodeEventLog(depositInterface.getEvent('DepositFlowStream'), [42n, sender, 100n])
    const event = await createSablierFlowV3Decoder({ getStreamContext: async () => ({ tokenAddress: token, senderWallet: sender, recipientWallet: recipient }) })({ ...logFor(), topics: encoded.topics, data: encoded.data })
    expect(event).toMatchObject({ type: 'stream_topped_up', streamProtocolId: '42', tokenAddress: token, senderWallet: sender, recipientWallet: recipient, amountBaseUnits: '100' })
  })

  it('requires an explicit HTTPS RPC URL for the provider factory', () => {
    expect(() => createBaseSepoliaFlowVerifier()).toThrow('Base Sepolia HTTPS RPC URL is required')
    const verifier = createBaseSepoliaFlowVerifier({ rpcUrl: 'https://base-sepolia.example.invalid' })
    expect(verifier.chainId).toBe(BASE_SEPOLIA_CHAIN_ID)
    expect(verifier.contractAddress.toLowerCase()).toBe(BASE_SEPOLIA_SABLIER_FLOW_V3)
  })
})
