// THE EVM SIDE: factory calldata and the arithmetic of a claim.
//
// A node verifies a deployed factory against the implementation it was told about, and prices the gas gift for
// a claim. Both used to be reachable only through the page. Names only.

export {
  FACTORY_METHODS,
  FACTORY_READS,
  ORDER_CREATED_TOPIC,
  QUOTE_FIELDS,
  decodeAddress,
  decodeImplementation,
  decodeImplementationCodeHash,
  encodeCreateOrderAndFund,
  encodeFactoryRead,
  encodePredict,
  verifyFactoryImplementation,
  verifyFactoryImplementationOnChain,
  word,
} from "../../engine/evm/factory.js";

export {
  CLAIM_GAS_LIMIT,
  CLAIM_TIP_FLOOR_WEI,
  DEFAULT_GIFT_RESERVE_BPS,
  claimGasGiftWei,
  claimMaxFeePerGasWei,
  claimRequiredWei,
} from "../../engine/evm/claimGas.js";
