import * as interchained from 'interchainedjs-lib';

/**
 * Combines two PSBTs and returns the combined PSBT.
 * @param {string} psbtBase64 - The base64 string of the first PSBT.
 * @param {string} newPSBTBase64 - The base64 string of the new PSBT to combine.
 * @returns {interchained.Psbt} - The combined PSBT.
 */
interface CombinePSBTsParams {
  psbtBase64: string;
  newPSBTBase64: string;
}

export const combinePSBTs = ({ psbtBase64, newPSBTBase64 }: CombinePSBTsParams): interchained.Psbt => {
  if (psbtBase64 === newPSBTBase64) {
    return interchained.Psbt.fromBase64(psbtBase64);
  }
  try {
    const psbt = interchained.Psbt.fromBase64(psbtBase64);
    const newPsbt = interchained.Psbt.fromBase64(newPSBTBase64);
    psbt.combine(newPsbt);
    return psbt;
  } catch (err) {
    console.error('Error combining PSBTs:', err);
    throw err;
  }
};
