import { gcm } from '@noble/ciphers/aes.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import * as SecureStore from 'expo-secure-store';

export const BACKUP_ENVELOPE_VERSION = 0x01;
export const PBKDF2_ITERATIONS = 210_000;
export const SALT_LENGTH_BYTES = 16;
export const IV_LENGTH_BYTES = 12;
export const TAG_LENGTH_BYTES = 16;
export const KEY_LENGTH_BYTES = 32;

export const HEADER_LENGTH_BYTES =
  1 + SALT_LENGTH_BYTES + IV_LENGTH_BYTES; // 29 bytes
export const MIN_ENVELOPE_LENGTH = HEADER_LENGTH_BYTES + TAG_LENGTH_BYTES; // 45 bytes

export const BACKUP_PASSPHRASE_STORAGE_KEY = 'nosotros_backup_passphrase_v1';

export interface KeyStoreAdapter {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync?(key: string): Promise<void>;
}

const defaultKeyStoreAdapter: KeyStoreAdapter = {
  getItemAsync: (key) => SecureStore.getItemAsync(key),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value),
  deleteItemAsync: (key) => SecureStore.deleteItemAsync(key),
};

export interface EncryptBackupOptions {
  customSalt?: Uint8Array;
  customIv?: Uint8Array;
}

export interface ParsedEnvelopeHeader {
  version: number;
  salt: Uint8Array;
  iv: Uint8Array;
  ciphertextAndTagLength: number;
}

/**
 * Derives a 256-bit symmetric encryption key from a user passphrase and salt
 * using PBKDF2-HMAC-SHA256 with 210,000 iterations.
 */
export function deriveKeyFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS,
): Uint8Array {
  if (!passphrase || typeof passphrase !== 'string' || passphrase.trim() === '') {
    throw new Error('INVALID_PASSPHRASE: Passphrase must be a non-empty string');
  }
  if (!salt || salt.length !== SALT_LENGTH_BYTES) {
    throw new Error(
      `INVALID_SALT: Salt must be exactly ${SALT_LENGTH_BYTES} bytes, got ${salt?.length ?? 0}`,
    );
  }

  return pbkdf2(sha256, passphrase, salt, {
    c: iterations,
    dkLen: KEY_LENGTH_BYTES,
  });
}

/**
 * Parses and validates the backup binary envelope header.
 */
export function parseBackupEnvelopeHeader(
  envelope: Uint8Array,
): ParsedEnvelopeHeader {
  if (!(envelope instanceof Uint8Array)) {
    throw new Error('INVALID_ENVELOPE: Envelope must be a Uint8Array');
  }
  if (envelope.length < MIN_ENVELOPE_LENGTH) {
    throw new Error(
      `INVALID_ENVELOPE_LENGTH: Backup envelope must be at least ${MIN_ENVELOPE_LENGTH} bytes, got ${envelope.length}`,
    );
  }

  const version = envelope[0];
  if (version !== BACKUP_ENVELOPE_VERSION) {
    throw new Error(
      `UNSUPPORTED_BACKUP_VERSION: Expected envelope version ${BACKUP_ENVELOPE_VERSION}, got ${version}`,
    );
  }

  const salt = envelope.slice(1, 1 + SALT_LENGTH_BYTES);
  const iv = envelope.slice(
    1 + SALT_LENGTH_BYTES,
    1 + SALT_LENGTH_BYTES + IV_LENGTH_BYTES,
  );
  const ciphertextAndTagLength = envelope.length - HEADER_LENGTH_BYTES;

  return {
    version,
    salt,
    iv,
    ciphertextAndTagLength,
  };
}

/**
 * Encrypts arbitrary plaintext data (string or Uint8Array) into an authenticated binary envelope:
 * Layout: [version (1B) | salt (16B) | iv (12B) | ciphertext + tag (variable)]
 *
 * Guaranteed:
 * - Unique 16B salt per invocation (unless customSalt specified)
 * - Unique 12B IV per invocation (never reused)
 * - AES-256-GCM authenticated encryption with 16B tag
 */
export function encryptBackup(
  plaintext: string | Uint8Array,
  passphrase: string,
  options?: EncryptBackupOptions,
): Uint8Array {
  const data =
    typeof plaintext === 'string'
      ? new TextEncoder().encode(plaintext)
      : plaintext;

  if (!(data instanceof Uint8Array)) {
    throw new Error('INVALID_PLAINTEXT: Plaintext must be a string or Uint8Array');
  }

  const salt = options?.customSalt ?? randomBytes(SALT_LENGTH_BYTES);
  if (salt.length !== SALT_LENGTH_BYTES) {
    throw new Error(
      `INVALID_SALT_LENGTH: Salt must be ${SALT_LENGTH_BYTES} bytes, got ${salt.length}`,
    );
  }

  const iv = options?.customIv ?? randomBytes(IV_LENGTH_BYTES);
  if (iv.length !== IV_LENGTH_BYTES) {
    throw new Error(
      `INVALID_IV_LENGTH: IV must be ${IV_LENGTH_BYTES} bytes, got ${iv.length}`,
    );
  }

  const key = deriveKeyFromPassphrase(passphrase, salt);
  const cipher = gcm(key, iv);
  const ciphertextWithTag = cipher.encrypt(data);

  const envelope = new Uint8Array(HEADER_LENGTH_BYTES + ciphertextWithTag.length);
  envelope[0] = BACKUP_ENVELOPE_VERSION;
  envelope.set(salt, 1);
  envelope.set(iv, 1 + SALT_LENGTH_BYTES);
  envelope.set(ciphertextWithTag, HEADER_LENGTH_BYTES);

  return envelope;
}

/**
 * Decrypts an authenticated backup envelope using the couple's passphrase.
 * Validates version, salt, IV, and cryptographic integrity of ciphertext + tag.
 * Throws on tampering or incorrect passphrase.
 */
export function decryptBackup(
  envelope: Uint8Array,
  passphrase: string,
): Uint8Array {
  const header = parseBackupEnvelopeHeader(envelope);
  const key = deriveKeyFromPassphrase(passphrase, header.salt);
  const ciphertextWithTag = envelope.subarray(HEADER_LENGTH_BYTES);

  try {
    const cipher = gcm(key, header.iv);
    return cipher.decrypt(ciphertextWithTag);
  } catch {
    throw new Error(
      'BACKUP_DECRYPTION_FAILED: Invalid passphrase or corrupted/tampered backup envelope',
    );
  }
}

/**
 * Decrypts a backup envelope and decodes the result as a UTF-8 string.
 */
export function decryptBackupToString(
  envelope: Uint8Array,
  passphrase: string,
): string {
  const decryptedBytes = decryptBackup(envelope, passphrase);
  return new TextDecoder().decode(decryptedBytes);
}

/**
 * Persists the couple backup passphrase securely in SecureStore.
 */
export async function saveBackupPassphrase(
  passphrase: string,
  adapter: KeyStoreAdapter = defaultKeyStoreAdapter,
): Promise<void> {
  if (!passphrase || passphrase.trim() === '') {
    throw new Error('Passphrase cannot be empty');
  }
  await adapter.setItemAsync(BACKUP_PASSPHRASE_STORAGE_KEY, passphrase);
}

/**
 * Retrieves the stored passphrase from SecureStore if available.
 */
export async function getBackupPassphrase(
  adapter: KeyStoreAdapter = defaultKeyStoreAdapter,
): Promise<string | null> {
  return adapter.getItemAsync(BACKUP_PASSPHRASE_STORAGE_KEY);
}

/**
 * Clears the stored passphrase from SecureStore.
 */
export async function clearBackupPassphrase(
  adapter: KeyStoreAdapter = defaultKeyStoreAdapter,
): Promise<void> {
  if (adapter.deleteItemAsync) {
    await adapter.deleteItemAsync(BACKUP_PASSPHRASE_STORAGE_KEY);
  }
}
