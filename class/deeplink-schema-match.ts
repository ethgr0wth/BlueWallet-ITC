import bip21, { TOptions } from 'bip21';
import * as interchained from 'interchainedjs-lib';
import URL from 'url';
import { readFileOutsideSandbox } from '../blue_modules/fs';
import { Chain } from '../models/bitcoinUnits';
import { WatchOnlyWallet } from './';
import Azteco from './azteco';
import Lnurl from './lnurl';
import type { TWallet } from './wallets/types';

type TCompletionHandlerParams = [string, object];
type TContext = {
  wallets: TWallet[];
  saveToDisk: () => void;
  addWallet: (wallet: TWallet) => void;
  setSharedCosigner: (cosigner: string) => void;
};

type TBothInterchainedAndLightning = { interchained: string; lndInvoice: string } | undefined;

class DeeplinkSchemaMatch {
  static hasSchema(schemaString: string): boolean {
    if (typeof schemaString !== 'string' || schemaString.length <= 0) return false;
    const lowercaseString = schemaString.trim().toLowerCase();
    return (
      lowercaseString.startsWith('interchained:') ||
      lowercaseString.startsWith('lightning:') ||
      lowercaseString.startsWith('blue:') ||
      lowercaseString.startsWith('bluewallet:') ||
      lowercaseString.startsWith('lapp:')
    );
  }

  /**
   * Examines the content of the event parameter.
   * If the content is recognizable, create a dictionary with the respective
   * navigation dictionary required by react-navigation
   *
   * @param event {{url: string}} URL deeplink as passed to app, e.g. `interchained:bc1qh6tf004ty7z7un2v5ntu4mkf630545gvhs45u7?amount=666&label=Yo`
   * @param completionHandler {function} Callback that returns [string, params: object]
   */
  static navigationRouteFor(
    event: { url: string },
    completionHandler: (args: TCompletionHandlerParams) => void,
    context: TContext = { wallets: [], saveToDisk: () => {}, addWallet: () => {}, setSharedCosigner: () => {} },
  ) {
    if (event.url === null) {
      return;
    }
    if (typeof event.url !== 'string') {
      return;
    }

    if (event.url.toLowerCase().startsWith('bluewallet:interchained:') || event.url.toLowerCase().startsWith('bluewallet:lightning:')) {
      event.url = event.url.substring(11);
    } else if (event.url.toLocaleLowerCase().startsWith('bluewallet://widget?action=')) {
      event.url = event.url.substring('bluewallet://'.length);
    }

    if (DeeplinkSchemaMatch.isWidgetAction(event.url)) {
      if (context.wallets.length >= 0) {
        const wallet = context.wallets[0];
        const action = event.url.split('widget?action=')[1];
        if (wallet.chain === Chain.ONCHAIN) {
          if (action === 'openSend') {
            completionHandler([
              'SendDetailsRoot',
              {
                screen: 'SendDetails',
                params: {
                  walletID: wallet.getID(),
                },
              },
            ]);
          } else if (action === 'openReceive') {
            completionHandler([
              'DetailViewStackScreensStack',
              {
                screen: 'ReceiveDetails',
                params: {
                  walletID: wallet.getID(),
                },
              },
            ]);
          }
        } else if (wallet.chain === Chain.OFFCHAIN) {
          if (action === 'openSend') {
            completionHandler([
              'ScanLNDInvoiceRoot',
              {
                screen: 'ScanLNDInvoice',
                params: {
                  walletID: wallet.getID(),
                },
              },
            ]);
          } else if (action === 'openReceive') {
            completionHandler(['LNDCreateInvoiceRoot', { screen: 'LNDCreateInvoice', params: { walletID: wallet.getID() } }]);
          }
        }
      }
    } else if (DeeplinkSchemaMatch.isPossiblySignedPSBTFile(event.url)) {
      readFileOutsideSandbox(decodeURI(event.url))
        .then(file => {
          if (file) {
            completionHandler([
              'SendDetailsRoot',
              {
                screen: 'PsbtWithHardwareWallet',
                params: {
                  deepLinkPSBT: file,
                },
              },
            ]);
          }
        })
        .catch(e => console.warn(e));
      return;
    } else if (DeeplinkSchemaMatch.isPossiblyCosignerFile(event.url)) {
      readFileOutsideSandbox(decodeURI(event.url))
        .then(file => {
          // checks whether the necessary json keys are present in order to set a cosigner,
          // doesn't validate the values this happens later
          if (!file || !this.hasNeededJsonKeysForMultiSigSharing(file)) {
            return;
          }
          context.setSharedCosigner(file);
        })
        .catch(e => console.warn(e));
    }
    let isBothInterchainedAndLightning: TBothInterchainedAndLightning;
    try {
      isBothInterchainedAndLightning = DeeplinkSchemaMatch.isBothInterchainedAndLightning(event.url);
    } catch (e) {
      console.log(e);
    }
    if (isBothInterchainedAndLightning) {
      completionHandler([
        'SelectWallet',
        {
          onWalletSelect: (wallet: TWallet, { navigation }: any) => {
            navigation.pop(); // close select wallet screen
            navigation.navigate(...DeeplinkSchemaMatch.isBothInterchainedAndLightningOnWalletSelect(wallet, isBothInterchainedAndLightning));
          },
        },
      ]);
    } else if (DeeplinkSchemaMatch.isInterchainedAddress(event.url)) {
      completionHandler([
        'SendDetailsRoot',
        {
          screen: 'SendDetails',
          params: {
            uri: event.url.replace('://', ':'),
          },
        },
      ]);
    } else if (DeeplinkSchemaMatch.isLightningInvoice(event.url)) {
      completionHandler([
        'ScanLNDInvoiceRoot',
        {
          screen: 'ScanLNDInvoice',
          params: {
            uri: event.url.replace('://', ':'),
          },
        },
      ]);
    } else if (DeeplinkSchemaMatch.isLnUrl(event.url)) {
      // at this point we can not tell if it is lnurl-pay or lnurl-withdraw since it needs additional async call
      // to the server, which is undesirable here, so LNDCreateInvoice screen will handle it for us and will
      // redirect user to LnurlPay screen if necessary
      completionHandler([
        'LNDCreateInvoiceRoot',
        {
          screen: 'LNDCreateInvoice',
          params: {
            uri: event.url.replace('lightning:', '').replace('LIGHTNING:', ''),
          },
        },
      ]);
    } else if (Lnurl.isLightningAddress(event.url)) {
      // this might be not just an email but a lightning address
      // @see https://lightningaddress.com
      completionHandler([
        'ScanLNDInvoiceRoot',
        {
          screen: 'ScanLNDInvoice',
          params: {
            uri: event.url,
          },
        },
      ]);
    } else if (Azteco.isRedeemUrl(event.url)) {
      completionHandler([
        'AztecoRedeemRoot',
        {
          screen: 'AztecoRedeem',
          params: Azteco.getParamsFromUrl(event.url),
        },
      ]);
    } else if (new WatchOnlyWallet().setSecret(event.url).init().valid()) {
      completionHandler([
        'AddWalletRoot',
        {
          screen: 'ImportWallet',
          params: {
            triggerImport: true,
            label: event.url,
          },
        },
      ]);
    } else {
      const urlObject = URL.parse(event.url, true); // eslint-disable-line n/no-deprecated-api
      (async () => {
        if (urlObject.protocol === 'bluewallet:' || urlObject.protocol === 'lapp:' || urlObject.protocol === 'blue:') {
          switch (urlObject.host) {
            case 'setelectrumserver':
              completionHandler([
                'ElectrumSettings',
                {
                  server: DeeplinkSchemaMatch.getServerFromSetElectrumServerAction(event.url),
                },
              ]);
              break;
            case 'setlndhuburl':
              completionHandler([
                'LightningSettings',
                {
                  url: DeeplinkSchemaMatch.getUrlFromSetLndhubUrlAction(event.url),
                },
              ]);
              break;
          }
        }
      })();
    }
  }

  /**
   * Extracts server from a deeplink like `bluewallet:setelectrumserver?server=electrum1.bluewallet.io%3A443%3As`
   * returns FALSE if none found
   *
   * @param url {string}
   * @return {string|boolean}
   */
  static getServerFromSetElectrumServerAction(url: string): string | false {
    if (!url.startsWith('bluewallet:setelectrumserver') && !url.startsWith('setelectrumserver')) return false;
    const splt = url.split('server=');
    if (splt[1]) return decodeURIComponent(splt[1]);
    return false;
  }

  /**
   * Extracts url from a deeplink like `bluewallet:setlndhuburl?url=https%3A%2F%2Flndhub.herokuapp.com`
   * returns FALSE if none found
   *
   * @param url {string}
   * @return {string|boolean}
   */
  static getUrlFromSetLndhubUrlAction(url: string): string | false {
    if (!url.startsWith('bluewallet:setlndhuburl') && !url.startsWith('setlndhuburl')) return false;
    const splt = url.split('url=');
    if (splt[1]) return decodeURIComponent(splt[1]);
    return false;
  }

  static isTXNFile(filePath: string): boolean {
    return (
      (filePath.toLowerCase().startsWith('file:') || filePath.toLowerCase().startsWith('content:')) &&
      filePath.toLowerCase().endsWith('.txn')
    );
  }

  static isPossiblySignedPSBTFile(filePath: string): boolean {
    return (
      (filePath.toLowerCase().startsWith('file:') || filePath.toLowerCase().startsWith('content:')) &&
      filePath.toLowerCase().endsWith('-signed.psbt')
    );
  }

  static isPossiblyPSBTFile(filePath: string): boolean {
    return (
      (filePath.toLowerCase().startsWith('file:') || filePath.toLowerCase().startsWith('content:')) &&
      filePath.toLowerCase().endsWith('.psbt')
    );
  }

  static isPossiblyCosignerFile(filePath: string): boolean {
    return (
      (filePath.toLowerCase().startsWith('file:') || filePath.toLowerCase().startsWith('content:')) &&
      filePath.toLowerCase().endsWith('.bwcosigner')
    );
  }

  static isBothInterchainedAndLightningOnWalletSelect(wallet: TWallet, uri: any): TCompletionHandlerParams {
    if (wallet.chain === Chain.ONCHAIN) {
      return [
        'SendDetailsRoot',
        {
          screen: 'SendDetails',
          params: {
            uri: uri.interchained,
            walletID: wallet.getID(),
          },
        },
      ];
    } else {
      return [
        'ScanLNDInvoiceRoot',
        {
          screen: 'ScanLNDInvoice',
          params: {
            uri: uri.lndInvoice,
            walletID: wallet.getID(),
          },
        },
      ];
    }
  }

  static isInterchainedAddress(address: string): boolean {
    address = address.replace('://', ':').replace('interchained:', '').replace('INTERCHAINED:', '').replace('interchained=', '').split('?')[0];
    let isValidInterchainedAddress = false;
    try {
      interchained.address.toOutputScript(address);
      isValidInterchainedAddress = true;
    } catch (err) {
      isValidInterchainedAddress = false;
    }
    return isValidInterchainedAddress;
  }

  static isLightningInvoice(invoice: string): boolean {
    let isValidLightningInvoice = false;
    if (
      invoice.toLowerCase().startsWith('lightning:lnb') ||
      invoice.toLowerCase().startsWith('lightning://lnb') ||
      invoice.toLowerCase().startsWith('lnb')
    ) {
      isValidLightningInvoice = true;
    }
    return isValidLightningInvoice;
  }

  static isLnUrl(text: string): boolean {
    return Lnurl.isLnurl(text);
  }

  static isWidgetAction(text: string): boolean {
    return text.startsWith('widget?action=');
  }

  static hasNeededJsonKeysForMultiSigSharing(str: string): boolean {
    let obj;

    // Check if it's a valid JSON
    try {
      obj = JSON.parse(str);
    } catch (e) {
      return false;
    }

    // Check for the existence and type of the keys
    return typeof obj.xfp === 'string' && typeof obj.xpub === 'string' && typeof obj.path === 'string';
  }

  static isBothInterchainedAndLightning(url: string): TBothInterchainedAndLightning {
    if (url.includes('lightning') && (url.includes('interchained') || url.includes('INTERCHAINED'))) {
      const txInfo = url.split(/(interchained:\/\/|INTERCHAINED:\/\/|interchained:|INTERCHAINED:|lightning:|lightning=|interchained=)+/);
      let btc: string | false = false;
      let lndInvoice: string | false = false;
      for (const [index, value] of txInfo.entries()) {
        try {
          // Inside try-catch. We dont wan't to  crash in case of an out-of-bounds error.
          if (value.startsWith('interchained') || value.startsWith('INTERCHAINED')) {
            btc = `interchained:${txInfo[index + 1]}`;
            if (!DeeplinkSchemaMatch.isInterchainedAddress(btc)) {
              btc = false;
              break;
            }
          } else if (value.startsWith('lightning')) {
            const lnpart = txInfo[index + 1].split('&').find(el => el.toLowerCase().startsWith('ln'));
            lndInvoice = `lightning:${lnpart}`;
            if (!this.isLightningInvoice(lndInvoice)) {
              lndInvoice = false;
              break;
            }
          }
        } catch (e) {
          console.log(e);
        }
        if (btc && lndInvoice) break;
      }
      if (btc && lndInvoice) {
        return { interchained: btc, lndInvoice };
      } else {
        return undefined;
      }
    }
    return undefined;
  }

  static bip21decode(uri?: string) {
    if (!uri) {
      throw new Error('No URI provided');
    }
    let replacedUri = uri;
    for (const replaceMe of ['INTERCHAINED://', 'interchained://', 'INTERCHAINED:']) {
      replacedUri = replacedUri.replace(replaceMe, 'interchained:');
    }

    return bip21.decode(replacedUri);
  }

  static bip21encode(address: string, options?: TOptions): string {
    // uppercase address if bech32 to satisfy BIP_0173
    const isBech32 = address.startsWith('bc1');
    if (isBech32) {
      address = address.toUpperCase();
    }

    for (const key in options) {
      if (key === 'label' && String(options[key]).replace(' ', '').length === 0) {
        delete options[key];
      }
      if (key === 'amount' && !(Number(options[key]) > 0)) {
        delete options[key];
      }
    }
    return bip21.encode(address, options);
  }

  static decodeInterchainedUri(uri: string) {
    let amount;
    let address = uri || '';
    let memo = '';
    let payjoinUrl = '';
    try {
      const parsedInterchainedUri = DeeplinkSchemaMatch.bip21decode(uri);
      address = parsedInterchainedUri.address ? parsedInterchainedUri.address.toString() : address;
      if ('options' in parsedInterchainedUri) {
        if (parsedInterchainedUri.options.amount) {
          amount = Number(parsedInterchainedUri.options.amount);
        }
        if (parsedInterchainedUri.options.label) {
          memo = parsedInterchainedUri.options.label;
        }
        if (parsedInterchainedUri.options.pj) {
          payjoinUrl = parsedInterchainedUri.options.pj;
        }
      }
    } catch (_) {}
    return { address, amount, memo, payjoinUrl };
  }
}

export default DeeplinkSchemaMatch;
