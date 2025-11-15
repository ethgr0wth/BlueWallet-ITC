import AsyncStorage from '@react-native-async-storage/async-storage';
import { sha256 } from '@noble/hashes/sha256';
import DefaultPreference from 'react-native-default-preference';
import RNSecureKeyStore, { ACCESSIBLE } from 'react-native-secure-key-store';
import { load, save } from '../elara_modules/AppStorage';

import * as encryption from '../blue_modules/encryption';
import presentAlert from '../components/Alert';
import { HDAezeedWallet } from './wallets/hd-aezeed-wallet';
import { HDLegacyBreadwalletWallet } from './wallets/hd-legacy-breadwallet-wallet';
import { HDLegacyElectrumSeedP2PKHWallet } from './wallets/hd-legacy-electrum-seed-p2pkh-wallet';
import { HDLegacyP2PKHWallet } from './wallets/hd-legacy-p2pkh-wallet';
import { HDSegwitBech32Wallet } from './wallets/hd-segwit-bech32-wallet';
import { HDSegwitElectrumSeedP2WPKHWallet } from './wallets/hd-segwit-electrum-seed-p2wpkh-wallet';
import { HDSegwitP2SHWallet } from './wallets/hd-segwit-p2sh-wallet';
import { LegacyWallet } from './wallets/legacy-wallet';
import { LightningCustodianWallet } from './wallets/lightning-custodian-wallet';
import { MultisigHDWallet } from './wallets/multisig-hd-wallet';
import { SegwitBech32Wallet } from './wallets/segwit-bech32-wallet';
import { SegwitP2SHWallet } from './wallets/segwit-p2sh-wallet';
import { SLIP39LegacyP2PKHWallet, SLIP39SegwitBech32Wallet, SLIP39SegwitP2SHWallet } from './wallets/slip39-wallets';
import { ExtendedTransaction, Transaction, TWallet } from './wallets/types';
import { WatchOnlyWallet } from './wallets/watch-only-wallet';
import { getLNDHub } from '../helpers/lndHub';

let usedBucketNum: boolean | number = false;
let savingInProgress = 0; // its both a flag and a counter of attempts to write to disk

export type TTXMetadata = {
  [txid: string]: {
    memo?: string;
  };
};

export type TCounterpartyMetadata = {
  /**
   * our contact identifier, such as bip47 payment code
   */
  [counterparty: string]: {
    /**
     * custom human-readable name we assign ourselves
     */
    label: string;
    /**
     * some counterparties cannot be deleted because they sent a notif tx onchain, so we just mark them as hidden when user deletes
     */
    hidden?: boolean;
  };
};

type TBucketStorage = {
  wallets: string[]; // array of serialized wallets, not actual wallet objects
  tx_metadata: TTXMetadata;
  counterparty_metadata: TCounterpartyMetadata;
};

type TStoredWalletTransactions = {
  flat?: Transaction[];
  byExternalIndex?: Record<string, Transaction[]>;
  byInternalIndex?: Record<string, Transaction[]>;
};

const isReactNative = typeof navigator !== 'undefined' && navigator?.product === 'ReactNative';
const WALLET_TRANSACTIONS_PREFIX = 'walletTransactions-';

export class BlueApp {
  static FLAG_ENCRYPTED = 'data_encrypted';
  static LNDHUB = 'lndhub';
  static DO_NOT_TRACK = 'donottrack';
  static HANDOFF_STORAGE_KEY = 'HandOff';

  private static _instance: BlueApp | null = null;

  static keys2migrate = [BlueApp.HANDOFF_STORAGE_KEY, BlueApp.DO_NOT_TRACK];

  public cachedPassword?: false | string;
  public tx_metadata: TTXMetadata;
  public counterparty_metadata: TCounterpartyMetadata;
  public wallets: TWallet[];

  constructor() {
    this.wallets = [];
    this.tx_metadata = {};
    this.counterparty_metadata = {};
    this.cachedPassword = false;
  }

  static getInstance(): BlueApp {
    if (!BlueApp._instance) {
      BlueApp._instance = new BlueApp();
    }

    return BlueApp._instance;
  }

  async migrateKeys() {
    // do not migrate keys if we are not in RN env
    if (!isReactNative) {
      return;
    }

    for (const key of BlueApp.keys2migrate) {
      try {
        const value = await RNSecureKeyStore.get(key);
        if (value) {
          await AsyncStorage.setItem(key, value);
          await RNSecureKeyStore.remove(key);
        }
      } catch (_) {}
    }
  }

  /**
   * Wrapper for storage call. Secure store works only in RN environment. AsyncStorage is
   * used for cli/tests
   */
  setItem = (key: string, value: any): Promise<any> => {
    if (isReactNative) {
      return RNSecureKeyStore.set(key, value, { accessible: ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    } else {
      return AsyncStorage.setItem(key, value);
    }
  };

  /**
   * Wrapper for storage call. Secure store works only in RN environment. AsyncStorage is
   * used for cli/tests
   */
  getItem = (key: string): Promise<any> => {
    if (isReactNative) {
      return RNSecureKeyStore.get(key);
    } else {
      return AsyncStorage.getItem(key);
    }
  };

  getItemWithFallbackToAppStorage = async (key: string): Promise<any | null> => {
    try {
      const value = await this.getItem(key);
      if (value !== null && value !== undefined) {
        return value;
      }
    } catch (error: any) {
      console.warn('error reading', key, error.message);
      console.warn('fallback to AppStorage');
    }

    const fallbackValue = load(key, null);
    if (fallbackValue === null || typeof fallbackValue === 'undefined') {
      return null;
    }

    if (typeof fallbackValue === 'string') {
      return fallbackValue;
    }

    try {
      return JSON.stringify(fallbackValue);
    } catch (error) {
      console.warn('could not stringify fallback value for key', key, error);
      return null;
    }
  };

  storageIsEncrypted = async (): Promise<boolean> => {
    let data;
    try {
      data = await this.getItemWithFallbackToAppStorage(BlueApp.FLAG_ENCRYPTED);
    } catch (error: any) {
      console.warn('error reading `' + BlueApp.FLAG_ENCRYPTED + '` key:', error.message);
      return false;
    }

    return Boolean(data);
  };

  isPasswordInUse = async (password: string) => {
    try {
      let data = await this.getItem('data');
      data = this.decryptData(data, password);
      return Boolean(data);
    } catch (_e) {
      return false;
    }
  };

  /**
   * Iterates through all values of `data` trying to
   * decrypt each one, and returns first one successfully decrypted
   */
  decryptData(data: string, password: string): boolean | string {
    data = JSON.parse(data);
    let decrypted;
    let num = 0;
    for (const value of data) {
      decrypted = encryption.decrypt(value, password);

      if (decrypted) {
        usedBucketNum = num;
        return decrypted;
      }
      num++;
    }

    return false;
  }

  decryptStorage = async (password: string): Promise<boolean> => {
    if (password === this.cachedPassword) {
      this.cachedPassword = undefined;
      await this.saveToDisk();
      this.wallets = [];
      this.tx_metadata = {};
      this.counterparty_metadata = {};
      return this.loadFromDisk();
    } else {
      throw new Error('Incorrect password. Please, try again.');
    }
  };

  encryptStorage = async (password: string): Promise<void> => {
    // assuming the storage is not yet encrypted
    await this.saveToDisk();
    let data = await this.getItem('data');
    // TODO: refactor ^^^ (should not save & load to fetch data)

    const encrypted = encryption.encrypt(data, password);
    data = [];
    data.push(encrypted); // putting in array as we might have many buckets with storages
    data = JSON.stringify(data);
    this.cachedPassword = password;
    await this.setItem('data', data);
    await this.setItem(BlueApp.FLAG_ENCRYPTED, '1');
    save('data', data);
    save(BlueApp.FLAG_ENCRYPTED, '1');
  };

  /**
   * Cleans up all current application data (wallets, tx metadata etc)
   * Encrypts the bucket and saves it storage
   */
  createFakeStorage = async (fakePassword: string): Promise<boolean> => {
    usedBucketNum = false; // resetting currently used bucket so we wont overwrite it
    this.wallets = [];
    this.tx_metadata = {};
    this.counterparty_metadata = {};

    const data: TBucketStorage = {
      wallets: [],
      tx_metadata: {},
      counterparty_metadata: {},
    };

    let buckets = await this.getItem('data');
    buckets = JSON.parse(buckets);
    buckets.push(encryption.encrypt(JSON.stringify(data), fakePassword));
    this.cachedPassword = fakePassword;
    const bucketsString = JSON.stringify(buckets);
    await this.setItem('data', bucketsString);
    save('data', bucketsString);
    save(BlueApp.FLAG_ENCRYPTED, '1');
    return (await this.getItem('data')) === bucketsString;
  };

  hashIt = (s: string): string => {
    return Buffer.from(sha256(s)).toString('hex');
  };

  private getWalletTransactionsStorageKey(walletId: string): string {
    return `${WALLET_TRANSACTIONS_PREFIX}${walletId}`;
  }

  private loadWalletTransactionsFromStorage(walletToInflate: TWallet): void {
    const storageKey = this.getWalletTransactionsStorageKey(walletToInflate.getID());
    const stored = load(storageKey, null) as TStoredWalletTransactions | null;
    if (!stored) {
      return;
    }

    const target: any = '_hdWalletInstance' in walletToInflate && walletToInflate._hdWalletInstance ? walletToInflate._hdWalletInstance : walletToInflate;

    if (Array.isArray(stored.flat)) {
      target._txs_by_external_index = stored.flat;
      return;
    }

    target._txs_by_external_index = target._txs_by_external_index || {};
    target._txs_by_internal_index = target._txs_by_internal_index || {};

    if (stored.byExternalIndex) {
      for (const [index, txs] of Object.entries(stored.byExternalIndex)) {
        target._txs_by_external_index[Number(index)] = txs;
      }
    }

    if (stored.byInternalIndex) {
      for (const [index, txs] of Object.entries(stored.byInternalIndex)) {
        target._txs_by_internal_index[Number(index)] = txs;
      }
    }
  }

  private saveWalletTransactionsToStorage(wallet: TWallet): void {
    const id = wallet.getID();
    const target: any = '_hdWalletInstance' in wallet && wallet._hdWalletInstance ? wallet._hdWalletInstance : wallet;
    const storageKey = this.getWalletTransactionsStorageKey(id);

    if (Array.isArray(target._txs_by_external_index)) {
      save(storageKey, { flat: target._txs_by_external_index });
      return;
    }

    const byExternalIndex: Record<string, Transaction[]> = {};
    const byInternalIndex: Record<string, Transaction[]> = {};

    if (target._txs_by_external_index) {
      for (const [index, txs] of Object.entries(target._txs_by_external_index)) {
        byExternalIndex[index] = txs as Transaction[];
      }
    }

    if (target._txs_by_internal_index) {
      for (const [index, txs] of Object.entries(target._txs_by_internal_index)) {
        byInternalIndex[index] = txs as Transaction[];
      }
    }

    save(storageKey, { byExternalIndex, byInternalIndex });
  }

  private clearWalletTransactionsFromStorage(walletId: string): void {
    const storageKey = this.getWalletTransactionsStorageKey(walletId);
    save(storageKey, null);
  }

  /**
   * Loads from storage all wallets and
   * maps them to `this.wallets`
   *
   * @param password If present means storage must be decrypted before usage
   * @returns {Promise.<boolean>}
   */
  async loadFromDisk(password?: string): Promise<boolean> {
    let dataRaw = await this.getItemWithFallbackToAppStorage('data');
    if (password) {
      if (!dataRaw) {
        return false;
      }
      dataRaw = this.decryptData(dataRaw, password);
      if (dataRaw) {
        // password is good, cache it
        this.cachedPassword = password;
      }
    }
    if (dataRaw !== null && typeof dataRaw !== 'undefined') {
      const data: TBucketStorage = JSON.parse(dataRaw);
      if (!data.wallets) return false;
      const wallets = data.wallets;
      for (const key of wallets) {
        // deciding which type is wallet and instantiating correct object
        const tempObj = JSON.parse(key);
        let unserializedWallet: TWallet;
        switch (tempObj.type) {
          case SegwitBech32Wallet.type:
            unserializedWallet = SegwitBech32Wallet.fromJson(key) as unknown as SegwitBech32Wallet;
            break;
          case SegwitP2SHWallet.type:
            unserializedWallet = SegwitP2SHWallet.fromJson(key) as unknown as SegwitP2SHWallet;
            break;
          case WatchOnlyWallet.type:
            unserializedWallet = WatchOnlyWallet.fromJson(key) as unknown as WatchOnlyWallet;
            unserializedWallet.init();
            if (unserializedWallet.isHd() && !unserializedWallet.isXpubValid()) {
              continue;
            }
            break;
          case HDLegacyP2PKHWallet.type:
            unserializedWallet = HDLegacyP2PKHWallet.fromJson(key) as unknown as HDLegacyP2PKHWallet;
            break;
          case HDSegwitP2SHWallet.type:
            unserializedWallet = HDSegwitP2SHWallet.fromJson(key) as unknown as HDSegwitP2SHWallet;
            break;
          case HDSegwitBech32Wallet.type:
            unserializedWallet = HDSegwitBech32Wallet.fromJson(key) as unknown as HDSegwitBech32Wallet;
            break;
          case HDLegacyBreadwalletWallet.type:
            unserializedWallet = HDLegacyBreadwalletWallet.fromJson(key) as unknown as HDLegacyBreadwalletWallet;
            break;
          case HDLegacyElectrumSeedP2PKHWallet.type:
            unserializedWallet = HDLegacyElectrumSeedP2PKHWallet.fromJson(key) as unknown as HDLegacyElectrumSeedP2PKHWallet;
            break;
          case HDSegwitElectrumSeedP2WPKHWallet.type:
            unserializedWallet = HDSegwitElectrumSeedP2WPKHWallet.fromJson(key) as unknown as HDSegwitElectrumSeedP2WPKHWallet;
            break;
          case MultisigHDWallet.type:
            unserializedWallet = MultisigHDWallet.fromJson(key) as unknown as MultisigHDWallet;
            break;
          case HDAezeedWallet.type:
            unserializedWallet = HDAezeedWallet.fromJson(key) as unknown as HDAezeedWallet;
            // migrate password to this.passphrase field
            // remove this code somewhere in year 2022
            if (unserializedWallet.secret.includes(':')) {
              const [mnemonic, passphrase] = unserializedWallet.secret.split(':');
              unserializedWallet.secret = mnemonic;
              unserializedWallet.passphrase = passphrase;
            }

            break;
          case SLIP39SegwitP2SHWallet.type:
            unserializedWallet = SLIP39SegwitP2SHWallet.fromJson(key) as unknown as SLIP39SegwitP2SHWallet;
            break;
          case SLIP39LegacyP2PKHWallet.type:
            unserializedWallet = SLIP39LegacyP2PKHWallet.fromJson(key) as unknown as SLIP39LegacyP2PKHWallet;
            break;
          case SLIP39SegwitBech32Wallet.type:
            unserializedWallet = SLIP39SegwitBech32Wallet.fromJson(key) as unknown as SLIP39SegwitBech32Wallet;
            break;
          case LightningCustodianWallet.type: {
            unserializedWallet = LightningCustodianWallet.fromJson(key) as unknown as LightningCustodianWallet;
            let lndhub: false | any = false;
            try {
              lndhub = await getLNDHub();
            } catch (error) {
              console.warn(error);
            }

            if (unserializedWallet.baseURI) {
              unserializedWallet.setBaseURI(unserializedWallet.baseURI); // not really necessary, just for the sake of readability
              console.log('using saved uri for for ln wallet:', unserializedWallet.baseURI);
            } else if (lndhub) {
              console.log('using wallet-wide settings ', lndhub, 'for ln wallet');
              unserializedWallet.setBaseURI(lndhub);
            } else {
              console.log('wallet does not have a baseURI. Continuing init...');
            }
            unserializedWallet.init();
            break;
          }
          case 'lightningLdk':
            // since ldk wallets are deprecated and removed, we need to handle a case when such wallet still exists in storage
            unserializedWallet = new HDSegwitBech32Wallet();
            unserializedWallet.setSecret(tempObj.secret.replace('ldk://', ''));
            break;
          case LegacyWallet.type:
          default:
            unserializedWallet = LegacyWallet.fromJson(key) as unknown as LegacyWallet;
            break;
        }

        try {
          this.loadWalletTransactionsFromStorage(unserializedWallet);
        } catch (error: any) {
          presentAlert({ message: error.message });
        }

        // done
        const ID = unserializedWallet.getID();
        if (!this.wallets.some(wallet => wallet.getID() === ID)) {
          this.wallets.push(unserializedWallet);
          this.tx_metadata = data.tx_metadata;
          this.counterparty_metadata = data.counterparty_metadata;
        }
      }
      return true;
    } else {
      return false; // failed loading data or loading/decryptin data
    }
  }

  /**
   * Lookup wallet in list by it's secret and
   * remove it from `this.wallets`
   *
   * @param wallet {AbstractWallet}
   */
  deleteWallet = (wallet: TWallet): void => {
    const ID = wallet.getID();
    const tempWallets = [];

    for (const value of this.wallets) {
      if (value.getID() === ID) {
        // the one we should delete
        // nop
      } else {
        // the one we must keep
        tempWallets.push(value);
      }
    }
    this.wallets = tempWallets;
    this.clearWalletTransactionsFromStorage(ID);
  };

  /**
   * Serializes and saves to storage object data.
   * If cached password is saved - finds the correct bucket
   * to save to, encrypts and then saves.
   *
   * @returns {Promise} Result of storage save
   */
  async saveToDisk(): Promise<void> {
    if (savingInProgress) {
      console.warn('saveToDisk is in progress');
      if (++savingInProgress > 10) presentAlert({ message: 'Critical error. Last actions were not saved' }); // should never happen
      await new Promise(resolve => setTimeout(resolve, 1000 * savingInProgress)); // sleep
      return this.saveToDisk();
    }
    savingInProgress = 1;

    try {
      const walletsToSave: string[] = []; // serialized wallets
      for (const key of this.wallets) {
        if (typeof key === 'boolean') continue;
        key.prepareForSerialization();
        // @ts-ignore wtf is wallet.current? Does it even exist?
        delete key.current;
        const keyCloned = Object.assign({}, key); // stripped-down version of a wallet to save to secure keystore
        if ('_hdWalletInstance' in key) {
          const k = keyCloned as any & WatchOnlyWallet;
          k._hdWalletInstance = Object.assign({}, key._hdWalletInstance);
          k._hdWalletInstance._txs_by_external_index = {};
          k._hdWalletInstance._txs_by_internal_index = {};
        }
        this.saveWalletTransactionsToStorage(key);
        // stripping down:
        if (key._txs_by_external_index) {
          keyCloned._txs_by_external_index = {};
          keyCloned._txs_by_internal_index = {};
        }

        if ('_bip47_instance' in keyCloned) {
          delete keyCloned._bip47_instance; // since it wont be restored into a proper class instance
        }

        walletsToSave.push(JSON.stringify({ ...keyCloned, type: keyCloned.type }));
      }

      let data: TBucketStorage | string[] /* either a bucket, or an array of encrypted buckets */ = {
        wallets: walletsToSave,
        tx_metadata: this.tx_metadata,
        counterparty_metadata: this.counterparty_metadata,
      };

      if (this.cachedPassword) {
        // should find the correct bucket, encrypt and then save
        const bucketsRaw = await this.getItemWithFallbackToAppStorage('data');
        if (!bucketsRaw) {
          throw new Error('Cannot read encrypted storage buckets');
        }
        const buckets = JSON.parse(bucketsRaw);
        const newData: string[] = []; // serialized buckets
        let num = 0;
        for (const bucket of buckets) {
          let decrypted;
          // if we had `usedBucketNum` during loadFromDisk(), no point to try to decode each bucket to find the one we
          // need, we just to find bucket with the same index
          if (usedBucketNum !== false) {
            if (num === usedBucketNum) {
              decrypted = true;
            }
            num++;
          } else {
            // we dont have `usedBucketNum` for whatever reason, so lets try to decrypt each bucket after bucket
            // till we find the right one
            decrypted = encryption.decrypt(bucket, this.cachedPassword);
          }

          if (!decrypted) {
            // no luck decrypting, its not our bucket
            newData.push(bucket);
          } else {
            // decrypted ok, this is our bucket
            // we serialize our object's data, encrypt it, and add it to buckets
            newData.push(encryption.encrypt(JSON.stringify(data), this.cachedPassword));
          }
        }

        data = newData;
      }

      const serializedData = JSON.stringify(data);
      await this.setItem('data', serializedData);
      await this.setItem(BlueApp.FLAG_ENCRYPTED, this.cachedPassword ? '1' : '');

      // now, backing up same data in AppStorage:
      save('data', serializedData);
      save(BlueApp.FLAG_ENCRYPTED, this.cachedPassword ? '1' : '');
    } catch (error: any) {
      console.error('save to disk exception:', error.message);
      presentAlert({ message: 'save to disk exception: ' + error.message });
    } finally {
      savingInProgress = 0;
    }
  }

  /**
   * For each wallet, fetches balance from remote endpoint.
   * Use getter for a specific wallet to get actual balance.
   * Returns void.
   * If index is present then fetch only from this specific wallet
   */
  fetchWalletBalances = async (index?: number): Promise<void> => {
    console.log('fetchWalletBalances for wallet#', typeof index === 'undefined' ? '(all)' : index);
    if (index || index === 0) {
      let c = 0;
      for (const wallet of this.wallets) {
        if (c++ === index) {
          await wallet.fetchBalance();
        }
      }
    } else {
      for (const wallet of this.wallets) {
        console.log('fetching balance for', wallet.getLabel());
        await wallet.fetchBalance();
      }
    }
  };

  /**
   * Fetches from remote endpoint all transactions for each wallet.
   * Returns void.
   * To access transactions - get them from each respective wallet.
   * If index is present then fetch only from this specific wallet.
   *
   * @param index {Integer} Index of the wallet in this.wallets array,
   *                        blank to fetch from all wallets
   * @return {Promise.<void>}
   */
  fetchWalletTransactions = async (index?: number) => {
    console.log('fetchWalletTransactions for wallet#', typeof index === 'undefined' ? '(all)' : index);
    if (index || index === 0) {
      let c = 0;
      for (const wallet of this.wallets) {
        if (c++ === index) {
          await wallet.fetchTransactions();

          if ('fetchPendingTransactions' in wallet) {
            await wallet.fetchPendingTransactions();
            await wallet.fetchUserInvoices();
          }
        }
      }
    } else {
      for (const wallet of this.wallets) {
        await wallet.fetchTransactions();
        if ('fetchPendingTransactions' in wallet) {
          await wallet.fetchPendingTransactions();
          await wallet.fetchUserInvoices();
        }
      }
    }
  };

  fetchSenderPaymentCodes = async (index?: number) => {
    console.log('fetchSenderPaymentCodes for wallet#', typeof index === 'undefined' ? '(all)' : index);
    if (index || index === 0) {
      const wallet = this.wallets[index];
      try {
        if (!(wallet.allowBIP47() && wallet.isBIP47Enabled() && 'fetchBIP47SenderPaymentCodes' in wallet)) return;
        await wallet.fetchBIP47SenderPaymentCodes();
      } catch (error) {
        console.error('Failed to fetch sender payment codes for wallet', index, error);
      }
    } else {
      for (const wallet of this.wallets) {
        try {
          if (!(wallet.allowBIP47() && wallet.isBIP47Enabled() && 'fetchBIP47SenderPaymentCodes' in wallet)) continue;
          await wallet.fetchBIP47SenderPaymentCodes();
        } catch (error) {
          console.error('Failed to fetch sender payment codes for wallet', wallet.label, error);
        }
      }
    }
  };

  getWallets = (): TWallet[] => {
    return this.wallets;
  };

  /**
   * Getter for all transactions in all wallets.
   * But if index is provided - only for wallet with corresponding index
   *
   * @param index {number|undefined} Wallet index in this.wallets. Empty (or undef) for all wallets.
   * @param limit {number} How many txs return, starting from the earliest. Default: all of them.
   * @param includeWalletsWithHideTransactionsEnabled {boolean} Wallets' _hideTransactionsInWalletsList property determines wether the user wants this wallet's txs hidden from the main list view.
   */
  getTransactions = (
    index?: number,
    limit: number = Infinity,
    includeWalletsWithHideTransactionsEnabled: boolean = false,
  ): ExtendedTransaction[] => {
    if (index || index === 0) {
      let txs: Transaction[] = [];
      let c = 0;
      for (const wallet of this.wallets) {
        if (c++ === index) {
          txs = txs.concat(wallet.getTransactions());

          const txsRet: ExtendedTransaction[] = [];
          const walletID = wallet.getID();
          const walletPreferredBalanceUnit = wallet.getPreferredBalanceUnit();
          txs.map(tx =>
            txsRet.push({
              ...tx,
              walletID,
              walletPreferredBalanceUnit,
            }),
          );
          return txsRet;
        }
      }
    }

    const txs: ExtendedTransaction[] = [];
    for (const wallet of this.wallets.filter(w => includeWalletsWithHideTransactionsEnabled || !w.getHideTransactionsInWalletsList())) {
      const walletTransactions: Transaction[] = wallet.getTransactions();
      const walletID = wallet.getID();
      const walletPreferredBalanceUnit = wallet.getPreferredBalanceUnit();
      for (const t of walletTransactions) {
        txs.push({
          ...t,
          walletID,
          walletPreferredBalanceUnit,
        });
      }
    }

    return txs
      .sort((a, b) => {
        const bTime = new Date(b.received!).getTime();
        const aTime = new Date(a.received!).getTime();
        return bTime - aTime;
      })
      .slice(0, limit);
  };

  /**
   * Getter for a sum of all balances of all wallets
   */
  getBalance = (): number => {
    let finalBalance = 0;
    for (const wal of this.wallets) {
      finalBalance += wal.getBalance();
    }
    return finalBalance;
  };

  isHandoffEnabled = async (): Promise<boolean> => {
    try {
      return !!(await AsyncStorage.getItem(BlueApp.HANDOFF_STORAGE_KEY));
    } catch (_) {}
    return false;
  };

  setIsHandoffEnabled = async (value: boolean): Promise<void> => {
    await AsyncStorage.setItem(BlueApp.HANDOFF_STORAGE_KEY, value ? '1' : '');
  };

  isDoNotTrackEnabled = async (): Promise<boolean> => {
    try {
      const keyExists = await AsyncStorage.getItem(BlueApp.DO_NOT_TRACK);
      if (keyExists !== null) {
        const doNotTrackValue = !!keyExists;
        if (doNotTrackValue) {
          await DefaultPreference.set(BlueApp.DO_NOT_TRACK, '1');
          AsyncStorage.removeItem(BlueApp.DO_NOT_TRACK);
        } else {
          return Boolean(await DefaultPreference.get(BlueApp.DO_NOT_TRACK));
        }
      }
    } catch (_) {}
    const doNotTrackValue = await DefaultPreference.get(BlueApp.DO_NOT_TRACK);
    return doNotTrackValue === '1' || false;
  };

  setDoNotTrack = async (value: boolean) => {
    if (value) {
      await DefaultPreference.set(BlueApp.DO_NOT_TRACK, '1');
    } else {
      await DefaultPreference.clear(BlueApp.DO_NOT_TRACK);
    }
  };

  /**
   * Simple async sleeper function
   */
  sleep = (ms: number): Promise<void> => {
    return new Promise(resolve => setTimeout(resolve, ms));
  };
}
