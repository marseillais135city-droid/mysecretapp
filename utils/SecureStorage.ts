import nacl from '@/components/CryptoPolyfill';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { decode as decodeBase64, encode as encodeBase64 } from 'base-64';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const STORAGE_KEY = "my_permanent_secret_key_v1";

const stringToUint8Array = (str: string) => {
    const arr = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i) & 0xFF;
    return arr;
};
const uint8ArrayToString = (arr: Uint8Array) => {
    let str = '';
    for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]);
    return str;
};
const fromHex = (hex: string) =>
    new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));

// Cache the derived encryption key
let cachedEncKey: Uint8Array | null = null;

/**
 * Derive a symmetric encryption key from the user's NaCl secret key.
 * Uses HKDF-like double SHA256 with domain separation for key derivation.
 */
async function getEncryptionKey(): Promise<Uint8Array | null> {
    if (cachedEncKey) return cachedEncKey;

    const stored = await SecureStore.getItemAsync(STORAGE_KEY);
    if (!stored) return null;

    // HKDF-like: Extract phase - hash the raw key material
    const extractHex = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        stored
    );
    // Expand phase - hash with domain separator for key isolation
    const expandHex = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        `ghost:secure_storage:v1:${extractHex}`
    );
    cachedEncKey = fromHex(expandHex.substring(0, 64)); // 32 bytes
    return cachedEncKey;
}

/**
 * Clear the cached encryption key (call on logout/account deletion)
 */
export function clearSecureStorageCache() {
    cachedEncKey = null;
}

/**
 * Encrypt and store a value in AsyncStorage.
 * Format stored: base64(nonce[24] + ciphertext)
 * Throws if encryption key is not available - caller must ensure keys exist.
 */
export async function secureSet(key: string, value: string): Promise<void> {
    const encKey = await getEncryptionKey();
    if (!encKey) {
        throw new Error('Encryption key not available. Ensure identity is created before storing data.');
    }

    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const messageBytes = stringToUint8Array(value);
    const encrypted = nacl.secretbox(messageBytes, nonce, encKey);

    const fullMessage = new Uint8Array(nonce.length + encrypted.length);
    fullMessage.set(nonce);
    fullMessage.set(encrypted, nonce.length);

    const encoded = encodeBase64(uint8ArrayToString(fullMessage));
    await AsyncStorage.setItem(key, encoded);
}

/**
 * Read and decrypt a value from AsyncStorage.
 * Returns null if key doesn't exist, decryption fails, or key not available.
 * Legacy plaintext data is auto-migrated on read if encryption key is available.
 */
export async function secureGet(key: string): Promise<string | null> {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;

    const encKey = await getEncryptionKey();
    if (!encKey) {
        // No encryption key available - cannot decrypt, return null for safety
        return null;
    }

    try {
        const decoded = decodeBase64(raw);
        const fullMessage = stringToUint8Array(decoded);

        if (fullMessage.length < nacl.secretbox.nonceLength + nacl.secretbox.overheadLength) {
            // Too short to be encrypted - attempt legacy migration
            return await migrateLegacyData(key, raw, encKey);
        }

        const nonce = fullMessage.slice(0, nacl.secretbox.nonceLength);
        const ciphertext = fullMessage.slice(nacl.secretbox.nonceLength);

        const decrypted = nacl.secretbox.open(ciphertext, nonce, encKey);
        if (!decrypted) {
            // Decryption failed - attempt legacy migration
            return await migrateLegacyData(key, raw, encKey);
        }

        return uint8ArrayToString(decrypted);
    } catch {
        // Base64 decode failed - attempt legacy migration
        return await migrateLegacyData(key, raw, encKey);
    }
}

/**
 * Try to migrate legacy plaintext data: validate as JSON, re-encrypt, return.
 * Returns null if data is not valid JSON (corrupted/tampered).
 */
async function migrateLegacyData(key: string, raw: string, encKey: Uint8Array): Promise<string | null> {
    try {
        // Only accept valid JSON as legacy data
        JSON.parse(raw);

        // Re-encrypt and store
        const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
        const messageBytes = stringToUint8Array(raw);
        const encrypted = nacl.secretbox(messageBytes, nonce, encKey);
        const fullMessage = new Uint8Array(nonce.length + encrypted.length);
        fullMessage.set(nonce);
        fullMessage.set(encrypted, nonce.length);
        const encoded = encodeBase64(uint8ArrayToString(fullMessage));
        await AsyncStorage.setItem(key, encoded);

        return raw;
    } catch {
        // Not valid JSON - corrupted or tampered data, discard
        console.warn(`[SecureStorage] Discarding corrupted data for key: ${key}`);
        await AsyncStorage.removeItem(key);
        return null;
    }
}

/**
 * Remove a key from AsyncStorage
 */
export async function secureClear(key: string): Promise<void> {
    await AsyncStorage.removeItem(key);
}

/**
 * Migrate a plaintext value to encrypted storage.
 * Reads the current value, re-encrypts it, and stores it back.
 */
export async function migrateToSecure(key: string): Promise<void> {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return;

    const encKey = await getEncryptionKey();
    if (!encKey) return;

    // Check if it's already encrypted by trying to base64 decode + decrypt
    try {
        const decoded = decodeBase64(raw);
        const fullMessage = stringToUint8Array(decoded);
        if (fullMessage.length >= nacl.secretbox.nonceLength + nacl.secretbox.overheadLength) {
            const nonce = fullMessage.slice(0, nacl.secretbox.nonceLength);
            const ciphertext = fullMessage.slice(nacl.secretbox.nonceLength);
            const result = nacl.secretbox.open(ciphertext, nonce, encKey);
            if (result) return; // Already encrypted, nothing to do
        }
    } catch {
        // Not encrypted yet, proceed with migration
    }

    // Re-store as encrypted
    await secureSet(key, raw);
}
