import { RouteProp, useIsFocused, useRoute } from '@react-navigation/native';
import * as interchained from 'interchainedjs-lib';
import React, { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import Base43 from '../../blue_modules/base43';
import * as fs from '../../blue_modules/fs';
import { BlueURDecoder, decodeUR, extractSingleWorkload } from '../../blue_modules/ur';
import { BlueText } from '../../BlueComponents';
import { openPrivacyDesktopSettings } from '../../class/camera';
import Button from '../../components/Button';
import { useTheme } from '../../components/themes';
import { isCameraAuthorizationStatusGranted } from '../../helpers/scan-qr';
import loc from '../../loc';
import { useExtendedNavigation } from '../../hooks/useExtendedNavigation';
import CameraScreen from '../../components/CameraScreen';
import SafeArea from '../../components/SafeArea';
import presentAlert from '../../components/Alert';
import { SendDetailsStackParamList } from '../../navigation/SendDetailsStackParamList.ts';
import { BlueSpacing40 } from '../../components/BlueSpacing';
import { BlueLoading } from '../../components/BlueLoading.tsx';

let decoder: BlueURDecoder | undefined;

type RouteProps = RouteProp<SendDetailsStackParamList, 'ScanQRCode'>;

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000000',
  },
  openSettingsContainer: {
    justifyContent: 'center',
    alignContent: 'center',
    alignItems: 'center',
    height: '100%',
  },
  backdoorButton: {
    width: 60,
    height: 60,
    backgroundColor: 'rgba(0,0,0,0.01)',
    position: 'absolute',
    top: 60,
    left: '50%',
    transform: [{ translateX: -30 }],
  },
  backdoorInputWrapper: { position: 'absolute', left: '5%', top: '0%', width: '90%', height: '70%', backgroundColor: 'white' },
  progressWrapper: { position: 'absolute', alignSelf: 'center', alignItems: 'center', top: '50%', padding: 8, borderRadius: 8 },
  backdoorInput: {
    height: '50%',
    marginTop: 5,
    marginHorizontal: 20,
    borderWidth: 1,
    borderRadius: 4,
    textAlignVertical: 'top',
  },
});

const ScanQRCode = () => {
  const [isLoading, setIsLoading] = useState(false);
  const navigation = useExtendedNavigation();
  const route = useRoute<RouteProps>();
  const navigationState = navigation.getState();
  const previousRoute = navigationState.routes[navigationState.routes.length - 2];
  const defaultLaunchedBy = previousRoute ? previousRoute.name : undefined;

  // NOTE: upstream uses `onBarScanned`; keep this contract
  const { launchedBy = defaultLaunchedBy, showFileImportButton, onBarScanned } = route.params || {};

  // Persist across renders (prevents duplicate firing without fragile hashing)
  const scannedCacheRef = useRef<Record<string, number>>({});

  const { colors } = useTheme();
  const isFocused = useIsFocused();
  const [backdoorPressed, setBackdoorPressed] = useState(0);
  const [urTotal, setUrTotal] = useState(0);
  const [urHave, setUrHave] = useState(0);
  const [backdoorText, setBackdoorText] = useState('');
  const [backdoorVisible, setBackdoorVisible] = useState(false);
  const [animatedQRCodeData, setAnimatedQRCodeData] = useState<Record<string, string>>({});
  const [cameraStatusGranted, setCameraStatusGranted] = useState<boolean | undefined>(undefined);

  const stylesHook = StyleSheet.create({
    openSettingsContainer: {
      backgroundColor: colors.brandingColor,
    },
    progressWrapper: { backgroundColor: colors.brandingColor, borderColor: colors.foregroundColor, borderWidth: 4 },
    backdoorInput: {
      borderColor: colors.formBorder,
      borderBottomColor: colors.formBorder,
      backgroundColor: colors.inputBackgroundColor,
      color: colors.foregroundColor,
    },
  });

  useEffect(() => {
    isCameraAuthorizationStatusGranted().then(setCameraStatusGranted);
  }, []);

  // -------- URv2 handling (segmented animated QR) --------
  const onReadUniformResourceV2 = (part: string) => {
    if (!decoder) decoder = new BlueURDecoder();
    try {
      decoder.receivePart(part);
      if (decoder.isComplete()) {
        const data = decoder.toString();
        decoder = undefined; // reset for future scans
        safelyReturnDataToCaller(data);
      } else {
        setUrTotal(100);
        setUrHave(Math.floor(decoder.estimatedPercentComplete() * 100));
      }
    } catch (error) {
      setIsLoading(true);
      presentAlert({
        title: loc.errors.error,
        message: loc._.invalid_animated_qr_code_fragment,
      });
    }
  };

  /**
   * URv1 (deprecated) — keep for compatibility
   */
  const onReadUniformResource = (ur: string) => {
    try {
      const [index, total] = extractSingleWorkload(ur);
      setUrTotal(total);
      setAnimatedQRCodeData(prev => {
        const updated = { ...prev, [`${index}of${total}`]: ur };
        setUrHave(Object.values(updated).length);
        if (Object.values(updated).length === total) {
          const payload = decodeUR(Object.values(updated));
          let data: string;
          const hexStr = Buffer.from(String(payload), 'hex').toString();
          if (hexStr.startsWith('psbt')) {
            data = Buffer.from(String(payload), 'hex').toString('base64'); // PSBT expected in base64
          } else {
            data = hexStr; // plain text
          }
          safelyReturnDataToCaller(data);
        }
        return updated;
      });
    } catch (error) {
      setIsLoading(true);
      presentAlert({
        title: loc.errors.error,
        message: loc._.invalid_animated_qr_code_fragment,
      });
    }
  };

  // -------- Single entry point after we decide what the data is --------
  const safelyReturnDataToCaller = (data: string) => {
    try {
      if (typeof onBarScanned === 'function') {
        try {
          onBarScanned(data);
        } catch {
          // ignore callback exceptions so UI never crashes
        }
      }
      if (launchedBy) {
        // RN v6-safe: navigate back to the route by name and merge params
        navigation.navigate({
          name: launchedBy,
          params: { onBarScanned: data },
          // @ts-ignore merge is supported by native stack
          merge: true,
        } as any);
      } else {
        navigation.goBack();
      }
    } catch (e) {
      presentAlert({ title: loc.errors.error, message: String(e ?? 'QR navigation error') });
    } finally {
      setIsLoading(false);
    }
  };

  // -------- Raw QR handler --------
  const onBarCodeRead = (ret: { data: string }) => {
    try {
      const raw = (ret?.data ?? '').trim();
      if (!raw) return;

      // duplicate suppression (per screen lifecycle)
      if (scannedCacheRef.current[raw]) return;
      scannedCacheRef.current[raw] = Date.now();

      // UR (animated) variants:
      const upper = raw.toUpperCase();
      if (upper.startsWith('UR:CRYPTO-ACCOUNT')) return onReadUniformResourceV2(raw);
      if (upper.startsWith('UR:CRYPTO-PSBT')) return onReadUniformResourceV2(raw);
      if (upper.startsWith('UR:CRYPTO-OUTPUT')) return onReadUniformResourceV2(raw);
      if (upper.startsWith('UR:BYTES')) {
        const splitted = raw.split('/');
        if (splitted.length === 3 && splitted[1].includes('-')) return onReadUniformResourceV2(raw);
      }
      if (upper.startsWith('UR')) return onReadUniformResource(raw);

      // Electrum Base43 → PSBT (best-effort probe)
      try {
        const hex = Base43.decode(raw); // may throw if not base43
        interchained.Psbt.fromHex(hex); // verify PSBT (throws if invalid)
        const base64 = Buffer.from(hex, 'hex').toString('base64');
        return safelyReturnDataToCaller(base64);
      } catch {
        // Not a Base43 PSBT; fall through
      }

      // Fallback: send raw string (BIP21, plain address, etc.)
      setIsLoading(true);
      return safelyReturnDataToCaller(raw);
    } catch (e) {
      setIsLoading(false);
      presentAlert({ title: loc.errors.error, message: String(e ?? 'QR error') });
    }
  };

  // -------- File & image pickers (reuse same handler) --------
  const showFilePicker = async () => {
    setIsLoading(true);
    try {
      const { data } = await fs.showFilePickerAndReadFile();
      if (data) onBarCodeRead({ data });
    } finally {
      setIsLoading(false);
    }
  };

  const onShowImagePickerButtonPress = () => {
    if (isLoading) return;
    setIsLoading(true);
    fs.showImagePickerAndReadImage()
      .then(data => {
        if (data) onBarCodeRead({ data });
      })
      .finally(() => setIsLoading(false));
  };

  const dismiss = () => navigation.goBack();

  // Normalize event payload shapes across scanner libs (VisionCamera/MLKit/ZXing)
  const handleReadCode = (event: any) => {
    const raw =
      event?.nativeEvent?.codeStringValue ??
      event?.nativeEvent?.displayValue ??
      event?.nativeEvent?.data ??
      event?.data ??
      '';
    if (typeof raw !== 'string' || !raw.trim()) return;
    onBarCodeRead({ data: raw.trim() });
  };

  const handleBackdoorOkPress = () => {
    setBackdoorVisible(false);
    const txt = backdoorText.trim();
    setBackdoorText('');
    if (txt) onBarCodeRead({ data: txt });
  };

  // invisible backdoor button for e2e testing
  const handleInvisibleBackdoorPress = async () => {
    setBackdoorPressed(prev => {
      const next = prev + 1;
      if (next >= 6) {
        // show manual input after 6 taps
        setBackdoorVisible(true);
        return 0;
      }
      return next;
    });
  };

  const render = isLoading ? (
    <BlueLoading />
  ) : (
    <View>
      {cameraStatusGranted === false ? (
        <View style={[styles.openSettingsContainer, stylesHook.openSettingsContainer]}>
          <BlueText>{loc.send.permission_camera_message}</BlueText>
          <BlueSpacing40 />
          <Button title={loc.send.open_settings} onPress={openPrivacyDesktopSettings} />
          <BlueSpacing40 />
          {showFileImportButton && <Button title={loc.wallets.import_file} onPress={showFilePicker} />}
          <BlueSpacing40 />
          <Button title={loc.wallets.list_long_choose} onPress={onShowImagePickerButtonPress} />
          <BlueSpacing40 />
          <Button title={loc._.cancel} onPress={dismiss} />
        </View>
      ) : isFocused && cameraStatusGranted ? (
        <CameraScreen
          onReadCode={handleReadCode}
          showFilePickerButton={showFileImportButton}
          showImagePickerButton={true}
          onFilePickerButtonPress={showFilePicker}
          onImagePickerButtonPress={onShowImagePickerButtonPress}
          onCancelButtonPress={dismiss}
        />
      ) : null}
      {urTotal > 0 && (
        <View style={[styles.progressWrapper, stylesHook.progressWrapper]} testID="UrProgressBar">
          <BlueText>{loc.wallets.please_continue_scanning}</BlueText>
          <BlueText>
            {urHave} / {urTotal}
          </BlueText>
        </View>
      )}
      {backdoorVisible && (
        <View style={styles.backdoorInputWrapper}>
          <BlueText>Provide QR code contents manually:</BlueText>
          <TextInput
            testID="scanQrBackdoorInput"
            multiline
            underlineColorAndroid="transparent"
            style={[styles.backdoorInput, stylesHook.backdoorInput]}
            autoCorrect={false}
            autoCapitalize="none"
            spellCheck={false}
            selectTextOnFocus={false}
            keyboardType={Platform.OS === 'android' ? 'visible-password' : 'default'}
            value={backdoorText}
            onChangeText={setBackdoorText}
          />
          <Button title="OK" testID="scanQrBackdoorOkButton" onPress={handleBackdoorOkPress} />
        </View>
      )}
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={loc._.qr_custom_input_button}
        testID="ScanQrBackdoorButton"
        style={styles.backdoorButton}
        onPress={handleInvisibleBackdoorPress}
      />
    </View>
  );

  return <SafeArea style={styles.root}>{render}</SafeArea>;
};

export default ScanQRCode;
