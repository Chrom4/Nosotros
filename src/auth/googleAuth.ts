import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from '@react-native-google-signin/google-signin';
import Constants from 'expo-constants';

let configured = false;

function resolveWebClientId(): string | null {
  const fromEnv = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const fromExtra = (
    Constants.expoConfig?.extra as { googleClientId?: string } | undefined
  )?.googleClientId;
  return fromExtra?.trim() || null;
}

/**
 * Configures Google Sign-In once per process using the Expo public OAuth client id.
 */
export function ensureGoogleSignInConfigured(): void {
  if (configured) {
    return;
  }
  const webClientId = resolveWebClientId();
  if (!webClientId) {
    throw new Error(
      'GOOGLE_CLIENT_ID_MISSING: Set EXPO_PUBLIC_GOOGLE_CLIENT_ID for Drive/Calendar OAuth.',
    );
  }
  GoogleSignin.configure({
    webClientId,
    offlineAccess: false,
    scopes: [
      'https://www.googleapis.com/auth/drive.appdata',
      'https://www.googleapis.com/auth/calendar.events',
    ],
  });
  configured = true;
}

export interface GoogleAccessTokenResult {
  accessToken: string;
  email: string | null;
}

/**
 * Interactive Google Sign-In returning a short-lived OAuth access token for Drive/Calendar REST.
 */
export async function signInWithGoogleForDrive(): Promise<GoogleAccessTokenResult> {
  ensureGoogleSignInConfigured();

  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  const response = await GoogleSignin.signIn();
  if (!isSuccessResponse(response)) {
    throw new Error('GOOGLE_SIGN_IN_CANCELLED');
  }

  const tokens = await GoogleSignin.getTokens();
  if (!tokens.accessToken) {
    throw new Error('GOOGLE_ACCESS_TOKEN_MISSING');
  }

  return {
    accessToken: tokens.accessToken,
    email: response.data.user.email ?? null,
  };
}

/**
 * Silent token refresh when a prior Google session exists on the device.
 */
export async function getGoogleAccessTokenSilently(): Promise<string | null> {
  try {
    ensureGoogleSignInConfigured();
    const current = GoogleSignin.getCurrentUser();
    if (!current) {
      return null;
    }
    const tokens = await GoogleSignin.getTokens();
    return tokens.accessToken || null;
  } catch {
    return null;
  }
}

export async function signOutGoogle(): Promise<void> {
  try {
    ensureGoogleSignInConfigured();
    await GoogleSignin.signOut();
  } catch {
    // Ignore sign-out errors when Google was never configured/signed in
  }
}

export function mapGoogleSignInError(err: unknown): string {
  if (isErrorWithCode(err)) {
    switch (err.code) {
      case statusCodes.SIGN_IN_CANCELLED:
        return 'Login Google cancelado.';
      case statusCodes.IN_PROGRESS:
        return 'Login Google já em andamento.';
      case statusCodes.PLAY_SERVICES_NOT_AVAILABLE:
        return 'Google Play Services indisponível neste aparelho.';
      default:
        break;
    }
  }
  if (err instanceof Error) {
    if (err.message.startsWith('GOOGLE_CLIENT_ID_MISSING')) {
      return 'Configure EXPO_PUBLIC_GOOGLE_CLIENT_ID para usar o Backup no Drive.';
    }
    return err.message;
  }
  return 'Falha no login Google.';
}
