import nacl from '@/components/CryptoPolyfill';
import { getServerURL } from '@/constants/Config';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { decode as decodeBase64, encode as encodeBase64 } from 'base-64';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const STORAGE_KEY = "my_permanent_secret_key_v1";

const stringToUint8Array = (str: string) => {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xFF;
    return bytes;
};
const uint8ArrayToString = (arr: Uint8Array) => {
    let str = '';
    for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]);
    return str;
};
const toHex = (buffer: Uint8Array) =>
    Array.prototype.map.call(new Uint8Array(buffer), (x: number) => ('00' + x.toString(16)).slice(-2)).join('');
const fromHex = (hex: string) =>
    new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));

// Cache to avoid recomputing on every request
let cachedSigningKeyPair: nacl.SignKeyPair | null = null;
let cachedMyID: string | null = null;
let cachedBoxSecretKey: Uint8Array | null = null;

/**
 * Load and cache the identity (box secret key, signing keypair, user ID)
 */
async function loadIdentity(): Promise<{ signingKeyPair: nacl.SignKeyPair; myID: string; boxSecretKey: Uint8Array } | null> {
    if (cachedSigningKeyPair && cachedMyID && cachedBoxSecretKey) {
        return { signingKeyPair: cachedSigningKeyPair, myID: cachedMyID, boxSecretKey: cachedBoxSecretKey };
    }

    const stored = await SecureStore.getItemAsync(STORAGE_KEY);
    if (!stored) return null;

    const boxSecretKey = new Uint8Array(stringToUint8Array(decodeBase64(stored)));
    const boxKeyPair = nacl.box.keyPair.fromSecretKey(boxSecretKey);
    const pkHex = toHex(boxKeyPair.publicKey);
    const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, pkHex);
    const myID = hash.substring(0, 12).toUpperCase();

    // Derive signing keypair from box secret key using SHA256 as seed
    // nacl.sign.keyPair.fromSeed needs exactly 32 bytes
    const seedHex = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, decodeBase64(stored));
    const seed = fromHex(seedHex.substring(0, 64)); // 32 bytes
    const signingKeyPair = nacl.sign.keyPair.fromSeed(seed);

    cachedSigningKeyPair = signingKeyPair;
    cachedMyID = myID;
    cachedBoxSecretKey = boxSecretKey;

    return { signingKeyPair, myID, boxSecretKey };
}

/**
 * Clear cached identity (call on logout/account deletion)
 */
export function clearAuthCache() {
    cachedSigningKeyPair = null;
    cachedMyID = null;
    cachedBoxSecretKey = null;
}

/**
 * Generate a new identity (box secret key) and store it securely.
 * Overwrites any existing identity.
 */
export async function generateNewIdentity(): Promise<void> {
    // Force reload comment
    const boxKeyPair = nacl.box.keyPair();
    const secretKeyB64 = encodeBase64(uint8ArrayToString(boxKeyPair.secretKey));
    await SecureStore.setItemAsync(STORAGE_KEY, secretKeyB64);

    // Reset cache so next load picks up the new key
    clearAuthCache();
}

/**
 * Get authentication headers for a server request.
 * Signs: "ID:timestamp:METHOD:path"
 */
export async function getAuthHeaders(path: string, method: string = 'GET'): Promise<Record<string, string>> {
    const identity = await loadIdentity();
    if (!identity) {
        console.warn('[AUTH] Cannot generate auth headers: identity not loaded');
        return {};
    }

    const timestamp = Date.now().toString();
    const message = `${identity.myID}:${timestamp}:${method.toUpperCase()}:${path}`;
    const messageBytes = stringToUint8Array(message);
    const signature = nacl.sign.detached(messageBytes, identity.signingKeyPair.secretKey);

    return {
        'X-Ghost-ID': identity.myID,
        'X-Ghost-Timestamp': timestamp,
        'X-Ghost-Signature': encodeBase64(uint8ArrayToString(signature)),
    };
}

/**
 * Get the current user's ID
 */
export async function getMyID(): Promise<string | null> {
    const identity = await loadIdentity();
    return identity?.myID ?? null;
}

/**
 * Get the box secret key
 */
export async function getBoxSecretKey(): Promise<Uint8Array | null> {
    const identity = await loadIdentity();
    return identity?.boxSecretKey ?? null;
}

/**
 * Get the signing public key in hex (for registration)
 */
export async function getSigningPublicKeyHex(): Promise<string | null> {
    const identity = await loadIdentity();
    if (!identity) return null;
    return toHex(identity.signingKeyPair.publicKey);
}

/**
 * Get the box public key in hex
 */
export async function getBoxPublicKeyHex(): Promise<string | null> {
    const identity = await loadIdentity();
    if (!identity) return null;
    const boxKeyPair = nacl.box.keyPair.fromSecretKey(identity.boxSecretKey);
    return toHex(boxKeyPair.publicKey);
}

/**
 * Register this user's public keys with the server.
 * Called once after key generation.
 */
export async function registerWithServer(): Promise<boolean> {
    try {
        const identity = await loadIdentity();
        if (!identity) return false;

        const boxPkHex = await getBoxPublicKeyHex();
        const signPkHex = await getSigningPublicKeyHex();
        if (!boxPkHex || !signPkHex) return false;

        const serverURL = await getServerURL();

        // Sign the registration itself
        const timestamp = Date.now().toString();
        const message = `${identity.myID}:${timestamp}:POST:/register`;
        const messageBytes = stringToUint8Array(message);
        const signature = nacl.sign.detached(messageBytes, identity.signingKeyPair.secretKey);

        const res = await fetch(`${serverURL}/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Ghost-ID': identity.myID,
                'X-Ghost-Timestamp': timestamp,
                'X-Ghost-Signature': encodeBase64(uint8ArrayToString(signature)),
            },
            body: JSON.stringify({
                id: identity.myID,
                publicKey: boxPkHex,
                signingKey: signPkHex,
            })
        });

        if (res.ok) {
            await AsyncStorage.setItem('auth_registered', 'true');
            return true;
        }

        const data = await res.json().catch(() => ({}));
        if (data.status === 'ALREADY_REGISTERED') {
            await AsyncStorage.setItem('auth_registered', 'true');
            return true;
        }

        return false;
    } catch (e) {
        console.error('[AUTH] Registration failed', e);
        return false;
    }
}

/**
 * Ensure the user is registered with the server
 */
export async function ensureRegistered(): Promise<void> {
    // We always attempt registration to ensure synchronization with the server state (e.g., if the DB was reset).
    // The server handles duplicate registrations gracefully (ALREADY_REGISTERED).
    await registerWithServer();
}

/**
 * Make an authenticated fetch request with automatic retry if the user is unknown to the server.
 */
export async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
    const urlObj = new URL(url);
    const path = urlObj.pathname;
    const method = options.method || 'GET';

    const getHeaders = async () => {
        const authHeaders = await getAuthHeaders(path, method);
        return {
            ...options.headers,
            ...authHeaders,
        };
    };

    let response = await fetch(url, {
        ...options,
        headers: await getHeaders(),
    });

    // If server says the user is unknown, attempt one re-registration and retry
    if (response.status === 401) {
        const body = await response.clone().json().catch(() => ({}));
        if (body.error === 'Unknown user. Register first.') {
            console.log('[AUTH] Unknown user error. Attempting re-registration...');
            const success = await registerWithServer();
            if (success) {
                console.log('[AUTH] Re-registration successful. Retrying request...');
                response = await fetch(url, {
                    ...options,
                    headers: await getHeaders(),
                });
            }
        }
    }

    return response;
}
