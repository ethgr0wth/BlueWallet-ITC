const bitcoin = require('interchainedjs-lib');
const ecc = require('tiny-secp256k1');
const { ECPairFactory } = require('ecpair');

// Needed for interchainedjs-lib v6+
bitcoin.initEccLib(ecc);

const INTERCHAINED = {
  messagePrefix: '\x18Interchained Signed Message:\n',
  bech32: 'itc',
  bip32: { public: 0x0488b21e, private: 0x0488ade4 },
  pubKeyHash: 0x00,
  scriptHash: 0x05,
  wif: 0x80,
};

const ECPair = ECPairFactory(ecc);
const keyPair = ECPair.makeRandom(); // you can also pass { network: INTERCHAINED }, but it's not required here
const { publicKey } = keyPair;

const { address } = bitcoin.payments.p2wpkh({
  pubkey: publicKey,
  network: INTERCHAINED,
});

console.log('Generated address:', address);

