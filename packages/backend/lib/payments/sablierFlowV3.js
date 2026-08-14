import { Interface, JsonRpcProvider, getAddress, isAddress } from 'ethers'

export const BASE_SEPOLIA_CHAIN_ID = 84532
export const BASE_SEPOLIA_SABLIER_FLOW_V3 = '0xc1ba5a41936aaab0ff920446db556efe17fc1c5d'

const FLOW_V3_EVENTS = [
  'event CreateFlowStream(uint256 streamId,address creator,address indexed sender,address indexed recipient,uint128 ratePerSecond,uint40 snapshotTime,address indexed token,bool transferable)',
  'event DepositFlowStream(uint256 indexed streamId,address indexed funder,uint128 amount)',
  'event PauseFlowStream(uint256 indexed streamId,address indexed sender,address indexed recipient,uint256 totalDebt)',
  'event RefundFromFlowStream(uint256 indexed streamId,address indexed sender,uint128 amount)',
  'event RestartFlowStream(uint256 indexed streamId,address indexed sender,uint128 ratePerSecond)',
  'event VoidFlowStream(uint256 indexed streamId,address indexed sender,address indexed recipient,address caller,uint256 newTotalDebt,uint256 writtenOffDebt)',
  'event WithdrawFromFlowStream(uint256 indexed streamId,address indexed to,address indexed token,address caller,uint128 withdrawAmount)'
]

const FLOW_V3_INTERFACE = new Interface(FLOW_V3_EVENTS)

export class SablierFlowV3Error extends Error {
  constructor(message) {
    super(message)
    this.name = 'SablierFlowV3Error'
  }
}

function requireAddress(value, fieldName) {
  if (!isAddress(value)) throw new SablierFlowV3Error(`${fieldName} must be a valid EVM address`)
  return getAddress(value)
}

function stringValue(value) {
  return typeof value === 'bigint' ? value.toString() : String(value)
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item))
}

function eventBase({ parsed, log, chainId, contractAddress, type, streamId, senderWallet, recipientWallet, tokenAddress, amountBaseUnits }) {
  return {
    type,
    finalityStatus: 'included',
    streamProtocolId: stringValue(streamId),
    chainId,
    protocolContractAddress: requireAddress(contractAddress, 'Protocol contract address'),
    tokenAddress: requireAddress(tokenAddress, 'Token address'),
    senderWallet: requireAddress(senderWallet, 'Sender wallet'),
    recipientWallet: requireAddress(recipientWallet, 'Recipient wallet'),
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    logIndex: log.index ?? log.logIndex,
    amountBaseUnits: stringValue(amountBaseUnits),
    rawPayload: { eventName: parsed.name, args: jsonSafe(parsed.args.toObject ? parsed.args.toObject() : {}) }
  }
}

export function createSablierFlowV3Decoder({ chainId = BASE_SEPOLIA_CHAIN_ID, contractAddress = BASE_SEPOLIA_SABLIER_FLOW_V3, getStreamContext = async () => null } = {}) {
  const normalizedContract = requireAddress(contractAddress, 'Sablier Flow contract address')
  if (!Number.isSafeInteger(Number(chainId)) || Number(chainId) < 1) throw new SablierFlowV3Error('chainId must be a positive safe integer')
  return async function decodeSablierFlowV3Log(log) {
    if (!log || String(log.address || '').toLowerCase() !== normalizedContract.toLowerCase()) return null
    let parsed
    try {
      parsed = FLOW_V3_INTERFACE.parseLog({ topics: log.topics, data: log.data })
    } catch {
      return null
    }
    if (!parsed) return null
    const args = parsed.args
    if (parsed.name === 'CreateFlowStream') return eventBase({ parsed, log, chainId: Number(chainId), contractAddress: normalizedContract, type: 'stream_created', streamId: args.streamId, senderWallet: args.sender, recipientWallet: args.recipient, tokenAddress: args.token, amountBaseUnits: args.ratePerSecond })

    const stream = await getStreamContext(stringValue(args.streamId))
    if (!stream) return null
    const senderWallet = stream.senderWallet || stream.sender_wallet
    const recipientWallet = stream.recipientWallet || stream.recipient_wallet
    const tokenAddress = stream.tokenAddress || stream.token_address
    if (parsed.name === 'DepositFlowStream') return eventBase({ parsed, log, chainId: Number(chainId), contractAddress: normalizedContract, type: 'stream_topped_up', streamId: args.streamId, senderWallet, recipientWallet, tokenAddress, amountBaseUnits: args.amount })
    if (parsed.name === 'PauseFlowStream') return eventBase({ parsed, log, chainId: Number(chainId), contractAddress: normalizedContract, type: 'stream_paused', streamId: args.streamId, senderWallet: args.sender, recipientWallet: args.recipient, tokenAddress, amountBaseUnits: args.totalDebt })
    if (parsed.name === 'RefundFromFlowStream') return eventBase({ parsed, log, chainId: Number(chainId), contractAddress: normalizedContract, type: 'stream_topped_up', streamId: args.streamId, senderWallet, recipientWallet, tokenAddress, amountBaseUnits: args.amount })
    if (parsed.name === 'RestartFlowStream') return eventBase({ parsed, log, chainId: Number(chainId), contractAddress: normalizedContract, type: 'stream_restarted', streamId: args.streamId, senderWallet: args.sender, recipientWallet, tokenAddress, amountBaseUnits: args.ratePerSecond })
    if (parsed.name === 'VoidFlowStream') return eventBase({ parsed, log, chainId: Number(chainId), contractAddress: normalizedContract, type: 'stream_voided', streamId: args.streamId, senderWallet: args.sender, recipientWallet: args.recipient, tokenAddress, amountBaseUnits: args.newTotalDebt })
    if (parsed.name === 'WithdrawFromFlowStream') return eventBase({ parsed, log, chainId: Number(chainId), contractAddress: normalizedContract, type: 'withdrawal', streamId: args.streamId, senderWallet, recipientWallet, tokenAddress: args.token, amountBaseUnits: args.withdrawAmount })
    return null
  }
}

export function createBaseSepoliaFlowVerifier({ rpcUrl, contractAddress = BASE_SEPOLIA_SABLIER_FLOW_V3, getStreamContext } = {}) {
  if (typeof rpcUrl !== 'string' || !/^https?:\/\//i.test(rpcUrl)) throw new SablierFlowV3Error('A Base Sepolia HTTPS RPC URL is required')
  const provider = new JsonRpcProvider(rpcUrl, { name: 'base-sepolia', chainId: BASE_SEPOLIA_CHAIN_ID }, { staticNetwork: true })
  return Object.freeze({
    provider,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    contractAddress: requireAddress(contractAddress, 'Sablier Flow contract address'),
    decodeLog: createSablierFlowV3Decoder({ chainId: BASE_SEPOLIA_CHAIN_ID, contractAddress, getStreamContext })
  })
}

export { FLOW_V3_EVENTS }
