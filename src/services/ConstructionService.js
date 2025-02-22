/**
 * Copyright (c) 2020-2022 The DigiByte Core developers
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
 * FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 * IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

const RosettaSDK = require('rosetta-node-sdk');
const bitcoinjs = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { ECPairFactory } = require('ecpair');

const Config = require('../../config');
const CustomNetworks = require('../CustomNetworks');
const Network = CustomNetworks[Config.network];
const OperationTypes = Config.serverConfig.operationTypes;
const { currency } = Config.serverConfig;

const rpc = require('../rpc');
const Errors = require('../../config/errors');
const DigiByteIndexer = require('../digibyteIndexer');
const ECPair = ECPairFactory(ecc);

const Types = RosettaSDK.Client;

/* Construction API */

/**
 * Derive an Address from a PublicKey
 * Derive returns the network-specific address associated with a public key. Blockchains that require an on-chain action to create an account should not implement this method.
 *
 * constructionDeriveRequest ConstructionDeriveRequest
 * returns ConstructionDeriveResponse
 * */
const constructionDerive = async (params) => {
  const { constructionDeriveRequest } = params;
  const { public_key } = constructionDeriveRequest;

  if (public_key.curve_type !== 'secp256k1') {
    return Errors.INVALID_CURVE_TYPE;
  }

  try {
    const p2pkh = bitcoinjs.payments.p2pkh({ pubkey: Buffer.from(public_key.hex_bytes, 'hex'), network: Network })
    return new Types.ConstructionDeriveResponse(p2pkh.address);
  } catch (e) {
    console.error(e);
    return Errors.UNABLE_TO_DERIVE_ADDRESS
      .addDetails({ reason: e.message });
  }
};

/**
 * Create a Request to Fetch Metadata
 * Preprocess is called prior to `/construction/payloads` to construct a request for any metadata that is needed for transaction construction given (i.e. account nonce). The request returned from this method will be used by the caller (in a different execution environment) to call the `/construction/metadata` endpoint.
 *
 * constructionPreprocessRequest ConstructionPreprocessRequest
 * returns ConstructionPreprocessResponse
 * */
const constructionPreprocess = async (params) => {
  const { constructionPreprocessRequest } = params;
  const { operations } = constructionPreprocessRequest;

  const requiredAmountForAccount = {};
  const requiredBalances = [];

  for (let operation of operations) {
    const { address } = operation.account;
    const amount = parseInt(operation.amount.value);

    // Skip if receiving address.
    if (amount >= 0) continue;

    const positiveAmount = -amount;

    /**
     * Group the required amount to the relevant account.
     */
    requiredAmountForAccount[address] = requiredAmountForAccount[address] || { sats: 0 };
    requiredAmountForAccount[address].sats += positiveAmount;
  }

  for (let account of Object.keys(requiredAmountForAccount)) {
    requiredBalances.push({
      account,
      amount: requiredAmountForAccount[account]
    });
  }

  return Types.ConstructionPreprocessResponse.constructFromObject({
    options: {
      required_balances: requiredBalances,
    },
  })
};

/**
 * Get Transaction Construction Metadata
 * Get any information required to construct a transaction for a specific network. Metadata returned here could be a recent hash to use, an account sequence number, or even arbitrary chain state. It is up to the client to correctly populate the options object with any network-specific details to ensure the correct metadata is retrieved.  It is important to clarify that this endpoint should not pre-construct any transactions for the client (this should happen in the SDK). This endpoint is left purposely unstructured because of the wide scope of metadata that could be required.  In a future version of the spec, we plan to pass an array of Rosetta Operations to specify which metadata should be received and to create a transaction in an accompanying SDK. This will help to insulate the client from chain-specific details that are currently required here.
 *
 * constructionMetadataRequest ConstructionMetadataRequest
 * returns ConstructionMetadataResponse
 * */
const constructionMetadata = async (params) => {
  const { constructionMetadataRequest } = params;
  const { options } = constructionMetadataRequest;

  if (!options || !Array.isArray(options.required_balances) ||
    options.required_balances.length === 0) throw Errors.EXPECTED_REQUIRED_ACCOUNTS;

  const relevantInputs = [];
  const scriptPubKeys = [];
  let change = 0;
  for (let requiredBalance of options.required_balances) {
    const { account, amount } = requiredBalance;

    // Get the utxos accociated with that address.
    const outputs = await DigiByteIndexer.getAccountUtxos(account);

    /**
     * Collect as many outputs as we need to fulfill
     * the requested balance operation.
     */
    let missing = -amount.sats;

    for (let output of outputs) {
      if (missing >= 0) continue;
      missing += output.sats;

      /**
       * Add this utxo to the relevant ones.
       */
      relevantInputs.push({
        txid: output.txid,
        vout: output.vout,
        address: account,
        satoshis: output.sats,
        scriptPubKey: output.scriptPubKey
      });

      scriptPubKeys.push(output.scriptPubKey)
    }

    // Can not fulfill the request.
    if (missing < 0) {
      throw Errors.INSUFFICIENT_BALANCE.addDetails({
        for_account: account,
      });
    }

    // Utxos gave too many satoshis. Add the difference to the change.
    if (missing > 0) {
      change += missing;
    }
  }

  // Return no metadata to work with
  return Types.ConstructionMetadataResponse.constructFromObject({
    metadata: {
      relevant_inputs: relevantInputs,
      script_pub_keys: scriptPubKeys,
      change,
    },
    suggested_fee: [],
  });
};

/**
 * Generate an Unsigned Transaction and Signing Payloads
 * Payloads is called with an array of operations and the response from `/construction/metadata`. It returns an unsigned transaction blob and a collection of payloads that must be signed by particular addresses using a certain SignatureType. The array of operations provided in transaction construction often times can not specify all \"effects\" of a transaction (consider invoked transactions in Ethereum). However, they can deterministically specify the \"intent\" of the transaction, which is sufficient for construction. For this reason, parsing the corresponding transaction in the Data API (when it lands on chain) will contain a superset of whatever operations were provided during construction.
 *
 * constructionPayloadsRequest ConstructionPayloadsRequest
 * returns ConstructionPayloadsResponse
 * */
const constructionPayloads = async (params) => {
  const { constructionPayloadsRequest } = params;
  const { operations, metadata } = constructionPayloadsRequest;

  if (!metadata || !Array.isArray(metadata.relevant_inputs) ||
    metadata.relevant_inputs.length === 0) throw Errors.EXPECTED_RELEVANT_INPUTS;

  const tx = new bitcoinjs.Transaction();
  tx.version = 2

  for (let operation of operations) {
    const amount = parseInt(operation.amount.value);
    if (amount < 0) continue;
    const scriptPubKey = bitcoinjs.address.toOutputScript(operation.account.address, Network);
    tx.addOutput(scriptPubKey, amount)
  }

  const payloads = []
  const inputAmounts = []
  const inputAddresses = []
  for (let i = 0; i < metadata.relevant_inputs.length; i++) {
    const relevantInput = metadata.relevant_inputs[i]
    const hash = Buffer.from(relevantInput.txid, 'hex').reverse()
    const scriptPubKey = Buffer.from(relevantInput.scriptPubKey, 'hex');
    tx.addInput(hash, relevantInput.vout, undefined, scriptPubKey)
    const sighash = tx.hashForSignature(
      i,
      scriptPubKey,
      bitcoinjs.Transaction.SIGHASH_ALL,
    );
    inputAmounts.push(relevantInput.satoshis)
    inputAddresses.push(relevantInput.address)
    payloads.push(Types.SigningPayload.constructFromObject({
      address: relevantInput.address,
      hex_bytes: sighash.toString('hex'),
      signature_type: new Types.SignatureType().ecdsa,
    }))
  }

  const unsignedTx = tx.toHex()
  const rawTx = JSON.stringify({
    transaction: unsignedTx,
    script_pub_keys: metadata.script_pub_keys,
    input_amounts: inputAmounts,
    input_addresses: inputAddresses,
  })
  return Types.ConstructionPayloadsResponse.constructFromObject({
    unsigned_transaction: rawTx,
    payloads,
  });
};

/**
 * Create Network Transaction from Signatures
 * Combine creates a network-specific transaction from an unsigned transaction and an array of provided signatures. The signed transaction returned from this method will be sent to the `/construction/submit` endpoint by the caller.
 *
 * constructionCombineRequest ConstructionCombineRequest
 * returns ConstructionCombineResponse
 * */
const constructionCombine = async (params) => {
  const { constructionCombineRequest } = params;
  const { unsigned_transaction, signatures } = constructionCombineRequest;
  const unsigned = JSON.parse(unsigned_transaction)
  const tx = bitcoinjs.Transaction.fromHex(unsigned.transaction);
  const inputs = tx.ins
  // assert lengths match
  if (signatures.length !== tx.ins.length) {
    throw new Error('Inputs and signatures length mismatch')
  }
  for (let i = 0; i < inputs.length; i++) {
    // get signature
    const signature = bitcoinjs.script.signature.encode(
      Buffer.from(signatures[i].hex_bytes, 'hex'),
      bitcoinjs.Transaction.SIGHASH_ALL,
    )
    // get pubkey
    const pubkey = Buffer.from(signatures[i].public_key.hex_bytes, 'hex')
    const keyPair = ECPair.fromPublicKey(pubkey, { network: Network, compressed: false });
    const p2pkhObj = bitcoinjs.payments.p2pkh({ pubkey: keyPair.publicKey, network: Network })
    const redeemScript = p2pkhObj.output

    const p2pkh = bitcoinjs.payments.p2pkh({
      output: redeemScript,
      pubkey: keyPair.publicKey,
      signature,
    })
    tx.setInputScript(i, p2pkh.input)
  }

  const signedTx = tx.toHex()
  const rawTx = JSON.stringify({
    transaction: signedTx,
    input_amounts: unsigned.input_amounts,
  })
  return Types.ConstructionCombineResponse.constructFromObject({
    signed_transaction: rawTx,
  });
};

/**
 * Get the Hash of a Signed Transaction
 * TransactionHash returns the network-specific transaction hash for a signed transaction.
 *
 * constructionHashRequest ConstructionHashRequest
 * returns TransactionIdentifierResponse
 * */
const constructionHash = async (params) => {
  const { constructionHashRequest } = params;
  const { signed_transaction } = constructionHashRequest
  const signed = JSON.parse(signed_transaction)
  const tx = bitcoinjs.Transaction.fromHex(signed.transaction);
  const hash = tx.getHash(true).reverse().toString('hex')
  return Types.TransactionIdentifierResponse.constructFromObject({
    transaction_identifier: Types.TransactionIdentifier.constructFromObject({ hash }),
  });
};

/**
 * Parse a Transaction
 * Parse is called on both unsigned and signed transactions to understand the intent of the formulated transaction. This is run as a sanity check before signing (after `/construction/payloads`) and before broadcast (after `/construction/combine`).
 *
 * constructionParseRequest ConstructionParseRequest
 * returns ConstructionParseResponse
 * */
const constructionParse = async (params) => {
  const { constructionParseRequest } = params;
  const { signed } = constructionParseRequest;
  if (signed) {
    return parseSignedTransaction(constructionParseRequest)
  }

  return parseUnsignedTransaction(constructionParseRequest)
};

const parseUnsignedTransaction = async (request) => {
  const { transaction } = request;
  const unsigned = JSON.parse(transaction)
  const tx = bitcoinjs.Transaction.fromHex(unsigned.transaction);
  const ops = []
  const inputs = tx.ins
  const outputs = tx.outs
  let i
  for (i = 0; i < inputs.length; i++) {
    const operation = Types.Operation.constructFromObject({
      operation_identifier: Types.OperationIdentifier.constructFromObject({ index: i }),
      type: OperationTypes.TRANSFER,
      status: '',
      account: Types.AccountIdentifier.constructFromObject({ address: unsigned.input_addresses[i] }),
      amount: Types.Amount.constructFromObject({ value: -unsigned.input_amounts[i], currency }),
    })
    ops.push(operation)
  }
  for (let y = 0; y < outputs.length; y++) {
    const output = outputs[y]
    const address = bitcoinjs.address.fromOutputScript(output.script, Network)
    const operation = Types.Operation.constructFromObject({
      operation_identifier: Types.OperationIdentifier.constructFromObject({ index: y + i }),
      type: OperationTypes.TRANSFER,
      status: '',
      account: Types.AccountIdentifier.constructFromObject({ address }),
      amount: Types.Amount.constructFromObject({ value: output.value, currency }),
    })
    ops.push(operation)
  }

  return Types.ConstructionParseResponse.constructFromObject({
    operations: ops,
    signers: [],
  });
}

const parseSignedTransaction = async (request) => {
  const { transaction } = request;
  const signed = JSON.parse(transaction)
  const tx = bitcoinjs.Transaction.fromHex(signed.transaction);
  const inputs = tx.ins
  const outputs = tx.outs
  const ops = []
  const signers = []
  let i
  let inputLength = inputs.length
  for (i = 0; i < inputLength; i++) {
    const input = inputs[i]
    const p2pkh = bitcoinjs.payments.p2pkh({
      input: input.script,
      network: Network,
    })
    const address = p2pkh.address
    signers.push(address)
    const operation = Types.Operation.constructFromObject({
      operation_identifier: Types.OperationIdentifier.constructFromObject({ index: i }),
      type: OperationTypes.TRANSFER,
      status: '',
      account: Types.AccountIdentifier.constructFromObject({ address }),
      amount: Types.Amount.constructFromObject({ value: -signed.input_amounts[i], currency }),
    })
    ops.push(operation)
  }
  for (let y = 0; y < outputs.length; y++) {
    const output = outputs[y]
    const address = bitcoinjs.address.fromOutputScript(output.script, Network)
    const operation = Types.Operation.constructFromObject({
      operation_identifier: Types.OperationIdentifier.constructFromObject({ index: y + i }),
      type: OperationTypes.TRANSFER,
      status: '',
      account: Types.AccountIdentifier.constructFromObject({ address }),
      amount: Types.Amount.constructFromObject({ value: output.value, currency }),
    })
    ops.push(operation)
  }
  return Types.ConstructionParseResponse.constructFromObject({
    operations: ops,
    signers,
  });
}

/**
 * Submit a Signed Transaction
 * Submit a pre-signed transaction to the node. This call should not block on the transaction being included in a block. Rather, it should return immediately with an indication of whether or not the transaction was included in the mempool.  The transaction submission response should only return a 200 status if the submitted transaction could be included in the mempool. Otherwise, it should return an error.
 *
 * constructionSubmitRequest ConstructionSubmitRequest
 * returns ConstructionSubmitResponse
 * */
const constructionSubmit = async (params) => {
  const { constructionSubmitRequest } = params;
  const { signed_transaction } = constructionSubmitRequest
  const signed = JSON.parse(signed_transaction)
  const txHash = await rpc.sendrawtransaction({ hexstring: signed.transaction })
  if (!txHash || !!txHash.code) {
    throw new Error(`RPC Error: ${ txHash.message }`)
  }
  return Types.TransactionIdentifierResponse.constructFromObject({
    transaction_identifier: Types.TransactionIdentifier.constructFromObject({ hash: txHash }),
  });
};

module.exports = {
  /* /construction/derive */
  constructionDerive,

  /* /construction/preprocess */
  constructionPreprocess,

  /* /construction/metadata */
  constructionMetadata,

  /* /construction/payloads */
  constructionPayloads,

  /* /construction/combine */
  constructionCombine,

  /* /construction/hash */
  constructionHash,

  /* /construction/parse */
  constructionParse,

  /* /construction/submit */
  constructionSubmit,
};
