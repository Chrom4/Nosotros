import {
  BACKUP_ENVELOPE_VERSION,
  HEADER_LENGTH_BYTES,
  MIN_ENVELOPE_LENGTH,
  SALT_LENGTH_BYTES,
  IV_LENGTH_BYTES,
  TAG_LENGTH_BYTES,
  encryptBackup,
  decryptBackup,
  decryptBackupToString,
  parseBackupEnvelopeHeader,
  deriveKeyFromPassphrase,
  saveBackupPassphrase,
  getBackupPassphrase,
  clearBackupPassphrase,
  type KeyStoreAdapter,
} from '@/sync/backupCrypto';

describe('TEST-BKP-01 — Passphrase-derived Backup Envelope & AES-256-GCM Verification', () => {
  const testPassphrase = 'casal-amor-e-financas-2026-segredo-forte';
  const sampleJsonPayload = JSON.stringify({
    version: 1,
    exportedAt: '2026-11-10T15:30:00.000Z',
    householdId: 'household-uuid-12345',
    data: {
      transactions: [
        {
          id: 'tx-1',
          description: 'Padaria & Supermercado — Compras da Semana 🥖🥑',
          amountCents: 15450,
        },
      ],
      accounts: [
        {
          id: 'acc-1',
          name: 'Conta Conjunta Nubank',
        },
      ],
    },
  });

  describe('1. Envelope Structure and Roundtrip', () => {
    it('encrypts and decrypts UTF-8 JSON payload with exact fidelity', () => {
      const envelope = encryptBackup(sampleJsonPayload, testPassphrase);
      expect(envelope).toBeInstanceOf(Uint8Array);
      expect(envelope.length).toBeGreaterThan(MIN_ENVELOPE_LENGTH);

      const decrypted = decryptBackupToString(envelope, testPassphrase);
      expect(decrypted).toBe(sampleJsonPayload);

      const parsed = JSON.parse(decrypted);
      expect(parsed.data.transactions[0].description).toBe(
        'Padaria & Supermercado — Compras da Semana 🥖🥑',
      );
      expect(parsed.data.transactions[0].amountCents).toBe(15450);
    });

    it('encrypts and decrypts raw binary Uint8Array payloads', () => {
      const rawBinary = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff, 0x42]);
      const envelope = encryptBackup(rawBinary, testPassphrase);

      const decrypted = decryptBackup(envelope, testPassphrase);
      expect(decrypted).toEqual(rawBinary);
    });

    it('produces an envelope adhering strictly to [version|salt|iv|ciphertext+tag] specifications', () => {
      const envelope = encryptBackup('test-data', testPassphrase);

      const header = parseBackupEnvelopeHeader(envelope);
      expect(header.version).toBe(BACKUP_ENVELOPE_VERSION);
      expect(header.version).toBe(0x01);
      expect(header.salt.length).toBe(SALT_LENGTH_BYTES); // 16 bytes
      expect(header.iv.length).toBe(IV_LENGTH_BYTES); // 12 bytes
      expect(header.ciphertextAndTagLength).toBe(
        'test-data'.length + TAG_LENGTH_BYTES, // plaintext len + 16-byte tag
      );
      expect(envelope.length).toBe(
        HEADER_LENGTH_BYTES + 'test-data'.length + TAG_LENGTH_BYTES,
      );
    });
  });

  describe('2. IV & Salt Uniqueness (Never Reuse IV/Salt)', () => {
    it('generates 100 distinct IVs and 100 distinct salts for identical inputs', () => {
      const iterations = 100;
      const seenIvs = new Set<string>();
      const seenSalts = new Set<string>();
      const seenEnvelopes = new Set<string>();

      for (let i = 0; i < iterations; i++) {
        const envelope = encryptBackup('static-identical-data', testPassphrase);
        const header = parseBackupEnvelopeHeader(envelope);

        const ivHex = Buffer.from(header.iv).toString('hex');
        const saltHex = Buffer.from(header.salt).toString('hex');
        const envHex = Buffer.from(envelope).toString('hex');

        expect(seenIvs.has(ivHex)).toBe(false);
        expect(seenSalts.has(saltHex)).toBe(false);
        expect(seenEnvelopes.has(envHex)).toBe(false);

        seenIvs.add(ivHex);
        seenSalts.add(saltHex);
        seenEnvelopes.add(envHex);
      }

      expect(seenIvs.size).toBe(iterations);
      expect(seenSalts.size).toBe(iterations);
      expect(seenEnvelopes.size).toBe(iterations);
    });
  });

  describe('3. Tamper Detection & Authentication Failures', () => {
    it('rejects envelope when version byte is altered', () => {
      const envelope = encryptBackup('hello world', testPassphrase);
      const tampered = new Uint8Array(envelope);
      tampered[0] = 0x99; // Invalid version

      expect(() => decryptBackup(tampered, testPassphrase)).toThrow(
        /UNSUPPORTED_BACKUP_VERSION/,
      );
    });

    it('rejects envelope if payload is truncated below minimum envelope length', () => {
      const shortEnvelope = new Uint8Array(MIN_ENVELOPE_LENGTH - 1);
      expect(() => decryptBackup(shortEnvelope, testPassphrase)).toThrow(
        /INVALID_ENVELOPE_LENGTH/,
      );
    });

    it('fails authentication if salt is tampered', () => {
      const envelope = encryptBackup('sensitive financial data', testPassphrase);
      const tampered = new Uint8Array(envelope);
      // Tamper byte in salt (indices 1 to 16)
      tampered[5] ^= 0x01;

      expect(() => decryptBackup(tampered, testPassphrase)).toThrow(
        /BACKUP_DECRYPTION_FAILED/,
      );
    });

    it('fails authentication if IV is tampered', () => {
      const envelope = encryptBackup('sensitive financial data', testPassphrase);
      const tampered = new Uint8Array(envelope);
      // Tamper byte in IV (indices 17 to 28)
      tampered[20] ^= 0x01;

      expect(() => decryptBackup(tampered, testPassphrase)).toThrow(
        /BACKUP_DECRYPTION_FAILED/,
      );
    });

    it('fails authentication if ciphertext is tampered', () => {
      const envelope = encryptBackup('sensitive financial data', testPassphrase);
      const tampered = new Uint8Array(envelope);
      // Tamper byte in ciphertext
      tampered[32] ^= 0x01;

      expect(() => decryptBackup(tampered, testPassphrase)).toThrow(
        /BACKUP_DECRYPTION_FAILED/,
      );
    });

    it('fails authentication if authentication tag is tampered', () => {
      const envelope = encryptBackup('sensitive financial data', testPassphrase);
      const tampered = new Uint8Array(envelope);
      // Tamper last byte of the 16-byte GCM tag
      tampered[tampered.length - 1] ^= 0x01;

      expect(() => decryptBackup(tampered, testPassphrase)).toThrow(
        /BACKUP_DECRYPTION_FAILED/,
      );
    });

    it('fails decryption when an incorrect passphrase is supplied', () => {
      const envelope = encryptBackup('sensitive financial data', testPassphrase);
      expect(() =>
        decryptBackup(envelope, 'wrong-couple-passphrase-attempt'),
      ).toThrow(/BACKUP_DECRYPTION_FAILED/);
    });
  });

  describe('4. PBKDF2 Key Derivation & Input Validation', () => {
    it('rejects empty or whitespace-only passphrases', () => {
      const validSalt = new Uint8Array(SALT_LENGTH_BYTES);
      expect(() => deriveKeyFromPassphrase('', validSalt)).toThrow(
        /INVALID_PASSPHRASE/,
      );
      expect(() => deriveKeyFromPassphrase('   ', validSalt)).toThrow(
        /INVALID_PASSPHRASE/,
      );
    });

    it('rejects salt with invalid byte length', () => {
      const badSalt = new Uint8Array(10);
      expect(() => deriveKeyFromPassphrase('passphrase', badSalt)).toThrow(
        /INVALID_SALT/,
      );
    });

    it('derives a consistent 32-byte key for identical passphrase and salt', () => {
      const fixedSalt = new Uint8Array(SALT_LENGTH_BYTES).fill(0x7a);
      // Use lower iterations for fast unit test of deterministic output
      const key1 = deriveKeyFromPassphrase('test-secret', fixedSalt, 1000);
      const key2 = deriveKeyFromPassphrase('test-secret', fixedSalt, 1000);

      expect(key1.length).toBe(32);
      expect(key1).toEqual(key2);
    });
  });

  describe('5. Passphrase Secure Store Adapter', () => {
    it('persists and retrieves passphrase through adapter', async () => {
      const memoryStorage: Record<string, string> = {};
      const mockAdapter: KeyStoreAdapter = {
        getItemAsync: async (key) => memoryStorage[key] ?? null,
        setItemAsync: async (key, val) => {
          memoryStorage[key] = val;
        },
        deleteItemAsync: async (key) => {
          delete memoryStorage[key];
        },
      };

      await saveBackupPassphrase('parceiro123', mockAdapter);
      const retrieved = await getBackupPassphrase(mockAdapter);
      expect(retrieved).toBe('parceiro123');

      await clearBackupPassphrase(mockAdapter);
      const afterClear = await getBackupPassphrase(mockAdapter);
      expect(afterClear).toBeNull();
    });
  });
});
