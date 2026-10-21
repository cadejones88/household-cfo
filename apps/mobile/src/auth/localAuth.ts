/**
 * Face ID (or the device passcode) through expo-local-authentication. Used for the unlock gate on open and for
 * the step-up before approvals, rule changes, settings and export. The result is only a yes/no on this phone;
 * the API's step-up proof is separate (see AuthProvider.stepUp).
 */
import * as LocalAuthentication from "expo-local-authentication";

export interface BiometricInfo {
  /** The phone has Face ID / Touch ID / fingerprint hardware with something enrolled. */
  available: boolean;
  /** Face ID specifically (the words on the screens say "Face ID" only when this is true). */
  faceId: boolean;
  /** No biometrics enrolled but a passcode exists: authenticateAsync falls back to it. */
  passcodeOnly: boolean;
}

export async function biometricInfo(): Promise<BiometricInfo> {
  try {
    const hardware = await LocalAuthentication.hasHardwareAsync();
    const enrolled = hardware && (await LocalAuthentication.isEnrolledAsync());
    const types = hardware ? await LocalAuthentication.supportedAuthenticationTypesAsync() : [];
    const faceId = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    return { available: enrolled, faceId: enrolled && faceId, passcodeOnly: !enrolled && level !== LocalAuthentication.SecurityLevel.NONE };
  } catch {
    return { available: false, faceId: false, passcodeOnly: false };
  }
}

/** The plain name for the unlock method on this phone. */
export function unlockWord(info: BiometricInfo): "Face ID" | "Touch ID" | "your passcode" {
  if (info.faceId) return "Face ID";
  if (info.available) return "Touch ID";
  return "your passcode";
}

/**
 * Ask the phone to confirm it's the signed-in person. Falls back to the device passcode when biometrics are
 * unavailable. Returns false on cancel, lockout or an error; never throws.
 */
export async function authenticateLocally(reason: string): Promise<boolean> {
  try {
    const r = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      cancelLabel: "Not now",
      disableDeviceFallback: false,
      fallbackLabel: "Use passcode",
    });
    return r.success;
  } catch {
    return false;
  }
}
