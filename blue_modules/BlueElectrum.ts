import BigNumber from 'bignumber.js';
import * as interchained from 'interchainedjs-lib';
import DefaultPreference from 'react-native-default-preference';
import { sha256 as _sha256 } from '@noble/hashes/sha256';

import { load, save } from '../elara_modules/AppStorage';
import { LegacyWallet, SegwitBech32Wallet, SegwitP2SHWallet, TaprootWallet } from '../class';
import presentAlert from '../components/Alert';
import loc from '../loc';
import { GROUP_IO_BLUEWALLET } from './currency';
import { ElectrumServerItem } from '../screen/settings/ElectrumSettings';
import { triggerWarningHapticFeedback } from './hapticFeedback';
import { AlertButton } from 'react-native';
import { uint8ArrayToHex } from './uint8array-extras/index';

const ElectrumClient = require('electrum-client');
const net = require('net');
const tls = require('tls');

type Utxo = {
  height: number;
  value: number;
  address: string;
  txid: string;
  vout: number;
  wif?: string;
};

type ElectrumTransaction = {
  txid: string;
  hash: string;
  version: number;
  size: number;
  vsize: number;
  weight: number;
  locktime: number;
  vin: {
    txid: string;
    vout: number;
    scriptSig: { asm: string; hex: string };
    txinwitness: string[];
    sequence: number;
    addresses?: string[];
    value?: number;
  }[];
  vout: {
    value: number;
    n: number;
    scriptPubKey: {
      asm: string;
      hex: string;
      reqSigs: number;
      type: string;
      addresses: string[];
    };
  }[];
  blockhash: string;
  confirmations: number;
  time: number;
  blocktime: number;
};

type ElectrumTransactionWithHex = ElectrumTransaction & {
  hex: string;
};

type MempoolTransaction = {
  height: 0;
  tx_hash: string;
  fee: number;
};

type Peer = {
  host: string;
  ssl?: number;
  tcp?: number;
};

export const ELECTRUM_HOST = 'electrum_host';
export const ELECTRUM_TCP_PORT = 'electrum_tcp_port';
export const ELECTRUM_SSL_PORT = 'electrum_ssl_port';
export const ELECTRUM_SERVER_HISTORY = 'electrum_server_history';
const ELECTRUM_CONNECTION_DISABLED = 'electrum_disabled';
const ELECTRUM_TRANSACTION_CACHE_KEY = 'electrum_transaction_cache';
const storageKey = 'ELECTRUM_PEERS';
const defaultPeer = { host: '173.249.33.184', ssl: 50002 };
export const hardcodedPeers: Peer[] = [
  { host: '173.249.33.184', ssl: 50002 },
  // { host: 'seed.interchained.org', ssl: 50002 },
];

export const suggestedServers: Peer[] = hardcodedPeers.map(peer => ({
  ...peer,
}));

let mainClient: typeof ElectrumClient | undefined;
let mainConnected: boolean = false;
let wasConnectedAtLeastOnce: boolean = false;
let serverName: string | false = false;
let disableBatching: boolean = false;
let connectionAttempt: number = 0;
let currentPeerIndex = Math.floor(Math.random() * hardcodedPeers.length);
let latestBlock: { height: number; time: number } | { height: undefined; time: undefined } = { height: undefined, time: undefined };
const txhashHeightCache: Record<string, number> = {};
let transactionCache: Record<string, unknown> | undefined;

function bitcoinjs_crypto_sha256(buffer: Uint8Array): Buffer {
  return Buffer.from(_sha256(buffer));
}

function getTransactionCache(): Record<string, unknown> {
  if (!transactionCache) {
    const cache = load(ELECTRUM_TRANSACTION_CACHE_KEY, {});
    if (cache && typeof cache === 'object') {
      transactionCache = cache as Record<string, unknown>;
    } else {
      transactionCache = {};
    }
  }
  return transactionCache;
}

function cloneCachedValue<T>(value: T): T {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return value;
  }
}

function rememberTransactionCache(cache: Record<string, unknown>): void {
  save(ELECTRUM_TRANSACTION_CACHE_KEY, cache);
}

export const getPreferredServer = async (): Promise<ElectrumServerItem | undefined> => {
  try {
    await DefaultPreference.setName(GROUP_IO_BLUEWALLET);
    const host = (await DefaultPreference.get(ELECTRUM_HOST)) as string;
    const tcpPort = await DefaultPreference.get(ELECTRUM_TCP_PORT);
    const sslPort = await DefaultPreference.get(ELECTRUM_SSL_PORT);

    console.log('Getting preferred server:', { host, tcpPort, sslPort });

    if (!host) {
      console.warn('Preferred server host is undefined');
      return;
    }

    return {
      host,
      tcp: tcpPort ? Number(tcpPort) : undefined,
      ssl: sslPort ? Number(sslPort) : undefined,
    };
  } catch (error) {
    console.error('Error in getPreferredServer:', error);
    return undefined;
  }
};

export const removePreferredServer = async () => {
  try {
    await DefaultPreference.setName(GROUP_IO_BLUEWALLET);
    console.log('Removing preferred server');
    await DefaultPreference.clear(ELECTRUM_HOST);
    await DefaultPreference.clear(ELECTRUM_TCP_PORT);
    await DefaultPreference.clear(ELECTRUM_SSL_PORT);
  } catch (error) {
    console.error('Error in removePreferredServer:', error);
  }
};

export async function isDisabled(): Promise<boolean> {
  let result;
  try {
    await DefaultPreference.setName(GROUP_IO_BLUEWALLET);
    const savedValue = await DefaultPreference.get(ELECTRUM_CONNECTION_DISABLED);
    console.log('Getting Electrum connection disabled state:', savedValue);
    if (savedValue === null) {
      result = false;
    } else {
      result = savedValue;
    }
  } catch (error) {
    console.error('Error getting Electrum connection disabled state:', error);
    result = false;
  }
  return !!result;
}

export async function setDisabled(disabled = true) {
  await DefaultPreference.setName(GROUP_IO_BLUEWALLET);
  console.log('Setting Electrum connection disabled state to:', disabled);
  return DefaultPreference.set(ELECTRUM_CONNECTION_DISABLED, disabled ? '1' : '');
}

function getCurrentPeer() {
  return hardcodedPeers[currentPeerIndex];
}

/**
 * Returns NEXT hardcoded electrum server (increments index after use)
 */
function getNextPeer() {
  const peer = getCurrentPeer();
  currentPeerIndex++;
  if (currentPeerIndex + 1 >= hardcodedPeers.length) currentPeerIndex = 0;
  return peer;
}

async function getSavedPeer(): Promise<Peer | null> {
  try {
    await DefaultPreference.setName(GROUP_IO_BLUEWALLET);
    const host = (await DefaultPreference.get(ELECTRUM_HOST)) as string;
    const tcpPort = await DefaultPreference.get(ELECTRUM_TCP_PORT);
    const sslPort = await DefaultPreference.get(ELECTRUM_SSL_PORT);

    console.log('Getting saved peer:', { host, tcpPort, sslPort });

    if (!host) {
      return null;
    }

    if (sslPort) {
      return { host, ssl: Number(sslPort) };
    }

    if (tcpPort) {
      return { host, tcp: Number(tcpPort) };
    }

    return null;
  } catch (error) {
    console.error('Error in getSavedPeer:', error);
    return null;
  }
}

export async function connectMain(): Promise<void> {
  if (await isDisabled()) {
    console.log('Electrum connection disabled by user. Skipping connectMain call');
    return;
  }
  let usingPeer = getNextPeer();
  const savedPeer = await getSavedPeer();
  if (savedPeer && savedPeer.host && (savedPeer.tcp || savedPeer.ssl)) {
    usingPeer = savedPeer;
  }

  console.log('Using peer:', JSON.stringify(usingPeer));

  try {
    console.log('begin connection:', JSON.stringify(usingPeer));
    mainClient = new ElectrumClient(net, tls, usingPeer.ssl || usingPeer.tcp, usingPeer.host, usingPeer.ssl ? 'tls' : 'tcp');

    mainClient.onError = function (e: { message: string }) {
      console.log('electrum mainClient.onError():', e.message);
      if (mainConnected) {
        mainClient?.close();
        mainClient = undefined;
        mainConnected = false;
        console.log('reconnecting after socket error');
        setTimeout(connectMain, usingPeer.host.endsWith('.onion') ? 4000 : 500);
      }
    };
    const ver = await mainClient.initElectrum({ client: 'bluewallet', version: '1.4' });
    if (ver && ver[0]) {
      console.log('connected to ', ver);
      serverName = ver[0];
      mainConnected = true;
      wasConnectedAtLeastOnce = true;
      if (ver[0].startsWith('ElectrumPersonalServer') || ver[0].startsWith('electrs') || ver[0].startsWith('Fulcrum')) {
        disableBatching = true;

        const [electrumImplementation, electrumVersion] = ver[0].split(' ');
        switch (electrumImplementation) {
          case 'electrs':
            if (semVerToInt(electrumVersion) >= semVerToInt('0.9.0')) {
              disableBatching = false;
            }
            break;
          case 'electrs-esplora':
            break;
          case 'Fulcrum':
            if (semVerToInt(electrumVersion) >= semVerToInt('1.9.0')) {
              disableBatching = false;
            }
            break;
        }
      }
      const header = await mainClient.blockchainHeaders_subscribe();
      if (header && header.height) {
        latestBlock = {
          height: header.height,
          time: Math.floor(+new Date() / 1000),
        };
      }
    }
  } catch (e) {
    mainConnected = false;
    console.log('bad connection:', JSON.stringify(usingPeer), e);
    mainClient?.close();
    mainClient = undefined;
  }

  if (!mainConnected) {
    console.log('retry');
    connectionAttempt = connectionAttempt + 1;
    mainClient?.close();
    mainClient = undefined;
    if (connectionAttempt >= 5) {
      presentNetworkErrorAlert(usingPeer);
    } else {
      console.log('reconnection attempt #', connectionAttempt);
      await new Promise(resolve => setTimeout(resolve, 500));
      return connectMain();
    }
  }
}

export async function presentResetToDefaultsAlert(): Promise<boolean> {
  const hasPreferredServer = await getPreferredServer();
  const serverHistoryStr = await DefaultPreference.get(ELECTRUM_SERVER_HISTORY);
  const serverHistory = typeof serverHistoryStr === 'string' ? JSON.parse(serverHistoryStr) : [];
  return new Promise(resolve => {
    triggerWarningHapticFeedback();

    const buttons: AlertButton[] = [];

    if (hasPreferredServer?.host && (hasPreferredServer.tcp || hasPreferredServer.ssl)) {
      buttons.push({
        text: loc.settings.electrum_reset,
        onPress: async () => {
          try {
            await DefaultPreference.setName(GROUP_IO_BLUEWALLET);
            await DefaultPreference.clear(ELECTRUM_HOST);
            await DefaultPreference.clear(ELECTRUM_SSL_PORT);
            await DefaultPreference.clear(ELECTRUM_TCP_PORT);
          } catch (e) {
            console.log(e);
          }
          resolve(true);
        },
        style: 'default',
      });
    }

    if (serverHistory.length > 0) {
      buttons.push({
        text: loc.settings.electrum_reset_to_default_and_clear_history,
        onPress: async () => {
          try {
            await DefaultPreference.setName(GROUP_IO_BLUEWALLET);
            await DefaultPreference.clear(ELECTRUM_SERVER_HISTORY);
            await DefaultPreference.clear(ELECTRUM_HOST);
            await DefaultPreference.clear(ELECTRUM_SSL_PORT);
            await DefaultPreference.clear(ELECTRUM_TCP_PORT);
          } catch (e) {
            console.log(e);
          }
          resolve(true);
        },
        style: 'destructive',
      });
    }

    buttons.push({
      text: loc._.cancel,
      onPress: () => resolve(false),
      style: 'cancel',
    });

    presentAlert({
      title: loc.settings.electrum_reset,
      message: loc.settings.electrum_reset_to_default,
      buttons,
      options: { cancelable: true },
    });
  });
}

const presentNetworkErrorAlert = async (usingPeer?: Peer) => {
  if (await isDisabled()) {
    console.log(
      'Electrum connection disabled by user. Perhaps we are attempting to show this network error alert after the user disabled connections.',
    );
    return;
  }

  presentAlert({
    allowRepeat: false,
    title: loc.errors.network,
    message: loc.formatString(
      usingPeer ? loc.settings.electrum_unable_to_connect : loc.settings.electrum_error_connect,
      usingPeer ? { server: `${usingPeer.host}:${usingPeer.ssl ?? usingPeer.tcp}` } : {},
    ),
    buttons: [
      {
        text: loc.wallets.list_tryagain,
        onPress: () => {
          connectionAttempt = 0;
          mainClient?.close();
          mainClient = undefined;
          setTimeout(connectMain, 500);
        },
        style: 'default',
      },
      {
        text: loc.settings.electrum_reset,
        onPress: () => {
          presentResetToDefaultsAlert().then(result => {
            if (result) {
              connectionAttempt = 0;
              mainClient?.close();
              mainClient = undefined;
              setTimeout(connectMain, 500);
            }
          });
        },
        style: 'destructive',
      },
      {
        text: loc._.cancel,
        onPress: () => {
          connectionAttempt = 0;
          mainClient?.close();
          mainClient = undefined;
        },
        style: 'cancel',
      },
    ],
    options: { cancelable: false },
  });
};

async function getRandomDynamicPeer(): Promise<Peer> {
  try {
    let peers = JSON.parse((await DefaultPreference.get(storageKey)) as string);
    peers = peers.sort(() => Math.random() - 0.5);
    for (const peer of peers) {
      const ret: Peer = { host: peer[0], ssl: peer[1] };
      ret.host = peer[1];

      if (peer[1] === 's') {
        ret.ssl = peer[2];
      } else {
        ret.tcp = peer[2];
      }

      for (const item of peer[2]) {
        if (item.startsWith('t')) {
          ret.tcp = item.replace('t', '');
        }
      }
      if (ret.host && ret.tcp) return ret;
    }

    return defaultPeer;
  } catch (_) {
    return defaultPeer;
  }
}

export const getBalanceByAddress = async function (address: string): Promise<{ confirmed: number; unconfirmed: number }> {
  try {
    if (!mainClient) throw new Error('Electrum client is not connected');
    const script = interchained.address.toOutputScript(address);
    const hash = bitcoinjs_crypto_sha256(script);
    const reversedHash = Buffer.from(hash).reverse();
    const balance = await mainClient.blockchainScripthash_getBalance(reversedHash.toString('hex'));
    balance.addr = address;
    return balance;
  } catch (error) {
    console.error('Error in getBalanceByAddress:', error);
    throw error;
  }
};

export const getConfig = async function () {
  if (!mainClient) throw new Error('Electrum client is not connected');
  return {
    host: mainClient.host,
    port: mainClient.port,
    serverName,
    connected: mainClient.timeLastCall !== 0 && mainClient.status,
  };
};

export const getSecondsSinceLastRequest = function () {
  return mainClient && mainClient.timeLastCall ? (+new Date() - mainClient.timeLastCall) / 1000 : -1;
};

export const getTransactionsByAddress = async function (address: string): Promise<ElectrumHistory[]> {
  if (!mainClient) throw new Error('Electrum client is not connected');
  const script = interchained.address.toOutputScript(address);
  const hash = bitcoinjs_crypto_sha256(script);
  const reversedHash = Buffer.from(hash).reverse();
  const history = await mainClient.blockchainScripthash_getHistory(reversedHash.toString('hex'));
  for (const h of history || []) {
    if (h.tx_hash) txhashHeightCache[h.tx_hash] = h.height;
  }

  return history;
};

export const getMempoolTransactionsByAddress = async function (address: string): Promise<MempoolTransaction[]> {
  if (!mainClient) throw new Error('Electrum client is not connected');
  const script = interchained.address.toOutputScript(address);
  const hash = bitcoinjs_crypto_sha256(script);
  const reversedHash = Buffer.from(hash).reverse();
  return mainClient.blockchainScripthash_getMempool(reversedHash.toString('hex'));
};

export const ping = async function () {
  try {
    await mainClient.server_ping();
    return true;
  } catch (_) {}

  mainConnected = false;
  return false;
};

export function txhexToElectrumTransaction(txhex: string): ElectrumTransactionWithHex {
  const tx = interchained.Transaction.fromHex(txhex);

  const ret: ElectrumTransactionWithHex = {
    txid: tx.getId(),
    hash: tx.getId(),
    version: tx.version,
    size: Math.ceil(txhex.length / 2),
    vsize: tx.virtualSize(),
    weight: tx.weight(),
    locktime: tx.locktime,
    vin: [],
    vout: [],
    hex: txhex,
    blockhash: '',
    confirmations: 0,
    time: 0,
    blocktime: 0,
  };

  if (txhashHeightCache[ret.txid]) {
    ret.confirmations = estimateCurrentBlockheight() - txhashHeightCache[ret.txid];
    if (ret.confirmations < 0) {
      ret.confirmations = 1;
    }
    ret.time = calculateBlockTime(txhashHeightCache[ret.txid]);
    ret.blocktime = calculateBlockTime(txhashHeightCache[ret.txid]);
  }

  for (const inn of tx.ins) {
    const txinwitness = [];
    if (inn.witness[0]) txinwitness.push(uint8ArrayToHex(inn.witness[0]));
    if (inn.witness[1]) txinwitness.push(uint8ArrayToHex(inn.witness[1]));

    ret.vin.push({
      txid: Buffer.from(inn.hash).reverse().toString('hex'),
      vout: inn.index,
      scriptSig: { hex: uint8ArrayToHex(inn.script), asm: '' },
      txinwitness,
      sequence: inn.sequence,
    });
  }

  let n = 0;
  for (const out of tx.outs) {
    const value = new BigNumber(out.value).dividedBy(100000000).toNumber();
    let address: false | string = false;
    let type: false | string = false;

    if (SegwitBech32Wallet.scriptPubKeyToAddress(uint8ArrayToHex(out.script))) {
      address = SegwitBech32Wallet.scriptPubKeyToAddress(uint8ArrayToHex(out.script));
      type = 'witness_v0_keyhash';
    } else if (SegwitP2SHWallet.scriptPubKeyToAddress(uint8ArrayToHex(out.script))) {
      address = SegwitP2SHWallet.scriptPubKeyToAddress(uint8ArrayToHex(out.script));
      type = '???';
    } else if (LegacyWallet.scriptPubKeyToAddress(uint8ArrayToHex(out.script))) {
      address = LegacyWallet.scriptPubKeyToAddress(uint8ArrayToHex(out.script));
      type = '???';
    } else {
      address = TaprootWallet.scriptPubKeyToAddress(uint8ArrayToHex(out.script));
      type = 'witness_v1_taproot';
    }

    if (!address) {
      throw new Error('Internal error: unable to decode address from output script');
    }

    ret.vout.push({
      value,
      n,
      scriptPubKey: {
        asm: '',
        hex: uint8ArrayToHex(out.script),
        reqSigs: 1,
        type,
        addresses: [address],
      },
    });
    n++;
  }
  return ret;
}

export const getTransactionsFullByAddress = async (address: string): Promise<ElectrumTransaction[]> => {
  const txs = await getTransactionsByAddress(address);
  const ret: ElectrumTransaction[] = [];
  for (const tx of txs) {
    let full;
    try {
      full = await mainClient.blockchainTransaction_get(tx.tx_hash, true);
    } catch (error: any) {
      if (String(error?.message ?? error).startsWith('verbose transactions are currently unsupported')) {
        const txhex = await mainClient.blockchainTransaction_get(tx.tx_hash, false);
        full = txhexToElectrumTransaction(txhex);
      } else {
        throw new Error(String(error?.message ?? error));
      }
    }
    full.address = address;
    for (const input of full.vin) {
      let prevTxForVin;
      try {
        prevTxForVin = await mainClient.blockchainTransaction_get(input.txid, true);
      } catch (error: any) {
        if (String(error?.message ?? error).startsWith('verbose transactions are currently unsupported')) {
          const txhex = await mainClient.blockchainTransaction_get(input.txid, false);
          prevTxForVin = txhexToElectrumTransaction(txhex);
        } else {
          throw new Error(String(error?.message ?? error));
        }
      }
      if (prevTxForVin && prevTxForVin.vout && prevTxForVin.vout[input.vout]) {
        input.value = prevTxForVin.vout[input.vout].value;
        if (prevTxForVin.vout[input.vout].scriptPubKey && prevTxForVin.vout[input.vout].scriptPubKey.addresses) {
          input.addresses = prevTxForVin.vout[input.vout].scriptPubKey.addresses;
        }
        if (prevTxForVin.vout[input.vout]?.scriptPubKey?.address) {
          input.addresses = [prevTxForVin.vout[input.vout].scriptPubKey.address];
        }
      }
    }

    for (const output of full.vout) {
      if (output?.scriptPubKey && output.scriptPubKey.addresses) output.addresses = output.scriptPubKey.addresses;
      if (output?.scriptPubKey?.address) output.addresses = [output.scriptPubKey.address];
    }
    full.inputs = full.vin;
    full.outputs = full.vout;
    delete full.vin;
    delete full.vout;
    delete full.hex;
    delete full.hash;
    ret.push(full);
  }

  return ret;
};
type MultiGetBalanceResponse = {
  balance: number;
  unconfirmed_balance: number;
  addresses: Record<string, { confirmed: number; unconfirmed: number }>;
};

export const multiGetBalanceByAddress = async (addresses: string[], batchsize: number = 200): Promise<MultiGetBalanceResponse> => {
  if (!mainClient) throw new Error('Electrum client is not connected');
  const ret = {
    balance: 0,
    unconfirmed_balance: 0,
    addresses: {} as Record<string, { confirmed: number; unconfirmed: number }>,
  };

  const chunks = splitIntoChunks(addresses, batchsize);
  for (const chunk of chunks) {
    const scripthashes = [];
    const scripthash2addr: Record<string, string> = {};
    for (const addr of chunk) {
      const script = interchained.address.toOutputScript(addr);
      const hash = bitcoinjs_crypto_sha256(script);
      const reversedHash = Buffer.from(hash).reverse().toString('hex');
      scripthashes.push(reversedHash);
      scripthash2addr[reversedHash] = addr;
    }

    let balances = [];

    if (disableBatching) {
      const promises = [];
      const index2scripthash: Record<number, string> = {};
      for (let promiseIndex = 0; promiseIndex < scripthashes.length; promiseIndex++) {
        promises.push(mainClient.blockchainScripthash_getBalance(scripthashes[promiseIndex]));
        index2scripthash[promiseIndex] = scripthashes[promiseIndex];
      }
      const promiseResults = await Promise.all(promises);
      for (let resultIndex = 0; resultIndex < promiseResults.length; resultIndex++) {
        balances.push({ result: promiseResults[resultIndex], param: index2scripthash[resultIndex] });
      }
    } else {
      balances = await mainClient.blockchainScripthash_getBalanceBatch(scripthashes);
    }

    for (const bal of balances) {
      if (bal.error) console.warn('multiGetBalanceByAddress():', bal.error);
      ret.balance += +bal.result.confirmed;
      ret.unconfirmed_balance += +bal.result.unconfirmed;
      ret.addresses[scripthash2addr[bal.param]] = bal.result;
    }
  }

  return ret;
};

export const multiGetUtxoByAddress = async function (addresses: string[], batchsize: number = 100): Promise<Record<string, Utxo[]>> {
  if (!mainClient) throw new Error('Electrum client is not connected');
  const ret: Record<string, any> = {};

  const chunks = splitIntoChunks(addresses, batchsize);
  for (const chunk of chunks) {
    const scripthashes = [];
    const scripthash2addr: Record<string, string> = {};
    for (const addr of chunk) {
      const script = interchained.address.toOutputScript(addr);
      const hash = bitcoinjs_crypto_sha256(script);
      const reversedHash = Buffer.from(hash).reverse().toString('hex');
      scripthashes.push(reversedHash);
      scripthash2addr[reversedHash] = addr;
    }

    let results = [];

    if (disableBatching) {
    } else {
      results = await mainClient.blockchainScripthash_listunspentBatch(scripthashes);
    }

    for (const utxos of results) {
      ret[scripthash2addr[utxos.param]] = utxos.result;
      for (const utxo of ret[scripthash2addr[utxos.param]]) {
        utxo.address = scripthash2addr[utxos.param];
        utxo.txid = utxo.tx_hash;
        utxo.vout = utxo.tx_pos;
        delete utxo.tx_pos;
        delete utxo.tx_hash;
      }
    }
  }

  return ret;
};

export type ElectrumHistory = {
  tx_hash: string;
  height: number;
  address: string;
};

export const multiGetHistoryByAddress = async function (
  addresses: string[],
  batchsize: number = 100,
): Promise<Record<string, ElectrumHistory[]>> {
  if (!mainClient) throw new Error('Electrum client is not connected');
  const ret: Record<string, ElectrumHistory[]> = {};

  const chunks = splitIntoChunks(addresses, batchsize);
  for (const chunk of chunks) {
    const scripthashes = [];
    const scripthash2addr: Record<string, string> = {};
    for (const addr of chunk) {
      const script = interchained.address.toOutputScript(addr);
      const hash = bitcoinjs_crypto_sha256(script);
      const reversedHash = Buffer.from(hash).reverse().toString('hex');
      scripthashes.push(reversedHash);
      scripthash2addr[reversedHash] = addr;
    }

    let results = [];

    if (disableBatching) {
      const promises = [];
      const index2scripthash: Record<number, string> = {};
      for (let promiseIndex = 0; promiseIndex < scripthashes.length; promiseIndex++) {
        index2scripthash[promiseIndex] = scripthashes[promiseIndex];
        promises.push(mainClient.blockchainScripthash_getHistory(scripthashes[promiseIndex]));
      }
      const histories = await Promise.all(promises);
      for (let historyIndex = 0; historyIndex < histories.length; historyIndex++) {
        results.push({ result: histories[historyIndex], param: index2scripthash[historyIndex] });
      }
    } else {
      results = await mainClient.blockchainScripthash_getHistoryBatch(scripthashes);
    }

    for (const history of results) {
      if (history.error) console.warn('multiGetHistoryByAddress():', history.error);
      ret[scripthash2addr[history.param]] = history.result || [];
      for (const result of history.result || []) {
        if (result.tx_hash) txhashHeightCache[result.tx_hash] = result.height;
      }

      for (const hist of ret[scripthash2addr[history.param]]) {
        hist.address = scripthash2addr[history.param];
      }
    }
  }

  return ret;
};

type MultiGetTransactionByTxidResult<T extends boolean> = T extends true ? Record<string, ElectrumTransaction> : Record<string, string>;

export async function multiGetTransactionByTxid<T extends boolean>(
  txids: string[],
  verbose: T,
  batchsize: number = 45,
): Promise<MultiGetTransactionByTxidResult<T>> {
  txids = txids.filter(txid => !!txid);
  if (!mainClient) throw new Error('Electrum client is not connected');
  const ret: MultiGetTransactionByTxidResult<T> = {};
  txids = [...new Set(txids)];

  const cache = getTransactionCache();
  const cacheKeySuffix = verbose ? '_verbose' : '_non_verbose';
  const keysCacheMiss = [];
  for (const txid of txids) {
    const cacheKey = txid + cacheKeySuffix;
    if (Object.prototype.hasOwnProperty.call(cache, cacheKey)) {
      const cachedValue = cache[cacheKey];
      if (cachedValue !== undefined) {
        ret[txid] = cloneCachedValue(cachedValue) as MultiGetTransactionByTxidResult<T>[typeof txid];
      }
    }

    if (!ret[txid]) keysCacheMiss.push(txid);
  }

  if (keysCacheMiss.length === 0) {
    return ret;
  }

  txids = keysCacheMiss;

  const chunks = splitIntoChunks(txids, batchsize);
  for (const chunk of chunks) {
    let results = [];

    if (disableBatching) {
      try {
        const promises = [];
        const index2txid: Record<number, string> = {};
        for (let promiseIndex = 0; promiseIndex < chunk.length; promiseIndex++) {
          const txid = chunk[promiseIndex];
          index2txid[promiseIndex] = txid;
          promises.push(mainClient.blockchainTransaction_get(txid, verbose));
        }

        const transactionResults = await Promise.all(promises);
        for (let resultIndex = 0; resultIndex < transactionResults.length; resultIndex++) {
          let tx = transactionResults[resultIndex];
          if (typeof tx === 'string' && verbose) {
            tx = txhexToElectrumTransaction(tx);
          }
          const txid = index2txid[resultIndex];
          results.push({ result: tx, param: txid });
        }
      } catch (error: any) {
        if (String(error?.message ?? error).startsWith('verbose transactions are currently unsupported')) {
          for (const txid of chunk) {
            try {
              let tx = await mainClient.blockchainTransaction_get(txid, false);
              tx = txhexToElectrumTransaction(tx);
              results.push({ result: tx, param: txid });
            } catch (err) {
              console.log(err);
            }
          }
        } else {
          for (const txid of chunk) {
            try {
              let tx = await mainClient.blockchainTransaction_get(txid, verbose);
              if (typeof tx === 'string' && verbose) {
                tx = txhexToElectrumTransaction(tx);
              }
              results.push({ result: tx, param: txid });
            } catch (err) {
              console.log(err);
            }
          }
        }
      }
    } else {
      results = await mainClient.blockchainTransaction_getBatch(chunk, verbose);
    }

    for (const txdata of results) {
      if (txdata.error && txdata.error.code === -32600) {
        txdata.result = await mainClient.blockchainTransaction_get(txdata.param, false);
        txdata.result = txhexToElectrumTransaction(txdata.result);
      }
      ret[txdata.param] = txdata.result;
      if (ret[txdata.param]) delete (ret[txdata.param] as any).hex;
    }
  }

  for (const txid of Object.keys(ret)) {
    const tx = ret[txid];
    if (typeof tx === 'string') continue;
    for (const vout of tx?.vout ?? []) {
      if (vout?.scriptPubKey?.address) vout.scriptPubKey.addresses = [vout.scriptPubKey.address];
    }
  }

  let cacheDirty = false;
  for (const txid of Object.keys(ret)) {
    const cacheKey = txid + cacheKeySuffix;
    const value = ret[txid];
    if (verbose && typeof value !== 'string' && (!value?.confirmations || value.confirmations < 7)) {
      continue;
    }
    cache[cacheKey] = cloneCachedValue(value);
    cacheDirty = true;
  }

  if (cacheDirty) {
    rememberTransactionCache(cache);
  }

  return ret;
}

export const waitTillConnected = async function (): Promise<boolean> {
  let waitTillConnectedInterval: NodeJS.Timeout | undefined;
  let retriesCounter = 0;
  if (await isDisabled()) {
    console.warn('Electrum connections disabled by user. waitTillConnected skipping...');
    return false;
  }
  return new Promise(function (resolve, reject) {
    waitTillConnectedInterval = setInterval(() => {
      if (mainConnected) {
        clearInterval(waitTillConnectedInterval);
        return resolve(true);
      }

      if (wasConnectedAtLeastOnce && retriesCounter++ >= 150) {
        clearInterval(waitTillConnectedInterval);
        presentNetworkErrorAlert();
        reject(new Error('Waiting for Electrum connection timeout'));
      }
    }, 100);
  });
};

function percentile(arr: number[], p: number) {
  if (arr.length === 0) return 0;
  if (typeof p !== 'number') throw new TypeError('p must be a number');
  if (p <= 0) return arr[0];
  if (p >= 1) return arr[arr.length - 1];

  const index = (arr.length - 1) * p;
  const lower = Math.floor(index);
  const upper = lower + 1;
  const weight = index % 1;

  if (upper >= arr.length) return arr[lower];
  return arr[lower] * (1 - weight) + arr[upper] * weight;
}

export const calcEstimateFeeFromFeeHistorgam = function (numberOfBlocks: number, feeHistorgram: number[][]) {
  let totalVsize = 0;
  const histogramToUse = [];
  for (const h of feeHistorgram) {
    let [fee, vsize] = h;
    let timeToStop = false;

    if (totalVsize + vsize >= 1000000 * numberOfBlocks) {
      vsize = 1000000 * numberOfBlocks - totalVsize;
      timeToStop = true;
    }

    histogramToUse.push({ fee, vsize });
    totalVsize += vsize;
    if (timeToStop) break;
  }

  let histogramFlat: number[] = [];
  for (const hh of histogramToUse) {
    histogramFlat = histogramFlat.concat(Array(Math.round(hh.vsize / 25000)).fill(hh.fee));
  }

  histogramFlat = histogramFlat.sort(function (a, b) {
    return a - b;
  });

  return Math.round(percentile(histogramFlat, 0.5) || 1);
};

export const estimateFees = async function (): Promise<{ fast: number; medium: number; slow: number }> {
  let histogram;
  let timeoutId;
  try {
    histogram = await Promise.race([
      mainClient.mempool_getFeeHistogram(),
      new Promise(resolve => (timeoutId = setTimeout(resolve, 15000))),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }

  const _fast = await estimateFee(1);
  const _medium = await estimateFee(18);
  const _slow = await estimateFee(144);

  if (!histogram || histogram?.[0]?.[0] > 1000) return { fast: _fast, medium: _medium, slow: _slow };

  const fast = Math.max(2, calcEstimateFeeFromFeeHistorgam(1, histogram));
  const medium = Math.max(1, Math.round((fast * _medium) / _fast));
  const slow = Math.max(1, Math.round((fast * _slow) / _fast));
  return { fast, medium, slow };
};

export const estimateFee = async function (numberOfBlocks: number): Promise<number> {
  if (!mainClient) throw new Error('Electrum client is not connected');
  numberOfBlocks = numberOfBlocks || 1;
  const coinUnitsPerKilobyte = await mainClient.blockchainEstimatefee(numberOfBlocks);
  if (coinUnitsPerKilobyte === -1) return 1;
  return Math.round(new BigNumber(coinUnitsPerKilobyte).dividedBy(1024).multipliedBy(100000000).toNumber());
};

export const serverFeatures = async function () {
  if (!mainClient) throw new Error('Electrum client is not connected');
  return mainClient.server_features();
};

export const broadcast = async function (hex: string) {
  if (!mainClient) throw new Error('Electrum client is not connected');
  try {
    const res = await mainClient.blockchainTransaction_broadcast(hex);
    return res;
  } catch (error) {
    return error;
  }
};

export const broadcastV2 = async function (hex: string): Promise<string> {
  if (!mainClient) throw new Error('Electrum client is not connected');
  return mainClient.blockchainTransaction_broadcast(hex);
};

export const estimateCurrentBlockheight = function (): number {
  if (latestBlock.height) {
    const timeDiff = Math.floor(+new Date() / 1000) - latestBlock.time;
    const extraBlocks = Math.floor(timeDiff / (9.93 * 60));
    return latestBlock.height + extraBlocks;
  }

  const baseTs = 1587570465609;
  const baseHeight = 627179;
  return Math.floor(baseHeight + (+new Date() - baseTs) / 1000 / 60 / 9.93);
};

export const calculateBlockTime = function (height: number): number {
  if (latestBlock.height) {
    return Math.floor(latestBlock.time + (height - latestBlock.height) * 9.93 * 60);
  }

  const baseTs = 1585837504;
  const baseHeight = 624083;
  return Math.floor(baseTs + (height - baseHeight) * 9.93 * 60);
};

export const testConnection = async function (host: string, tcpPort?: number, sslPort?: number): Promise<boolean> {
  const client = new ElectrumClient(net, tls, sslPort || tcpPort, host, sslPort ? 'tls' : 'tcp');

  client.onError = () => {};
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    const rez = await Promise.race([
      new Promise(resolve => {
        timeoutId = setTimeout(() => resolve('timeout'), 5000);
      }),
      client.connect(),
    ]);
    if (rez === 'timeout') return false;

    await client.server_version('2.7.11', '1.4');
    await client.server_ping();
    return true;
  } catch (_) {
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    client.close();
  }

  return false;
};

export const forceDisconnect = (): void => {
  mainClient?.close();
};

export const setBatchingDisabled = () => {
  disableBatching = true;
};

export const setBatchingEnabled = () => {
  disableBatching = false;
};

const splitIntoChunks = function (arr: any[], chunkSize: number) {
  const groups = [];
  let i;
  for (i = 0; i < arr.length; i += chunkSize) {
    groups.push(arr.slice(i, i + chunkSize));
  }
  return groups;
};

const semVerToInt = function (semver: string): number {
  if (!semver) return 0;
  if (semver.split('.').length !== 3) return 0;

  const ret = Number(semver.split('.')[0]) * 1000000 + Number(semver.split('.')[1]) * 1000 + Number(semver.split('.')[2]) * 1;

  if (isNaN(ret)) return 0;

  return ret;
};
