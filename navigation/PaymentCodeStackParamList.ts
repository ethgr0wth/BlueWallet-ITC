import { InterchainedUnit } from '../models/bitcoinUnits';

export type PaymentCodeStackParamList = {
  PaymentCode: { paymentCode: string };
  PaymentCodesList: {
    memo: string;
    address: string;
    walletID: string;
    amount: number;
    amountSats: number;
    unit: InterchainedUnit;
    isTransactionReplaceable: boolean;
    launchedBy: string;
    isEditable: boolean;
    uri: string /* payjoin uri */;
  };
};
