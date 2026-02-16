import * as Crypto from 'expo-crypto';
import nacl from 'tweetnacl';

// Polyfill for TweetNaCl PRNG
nacl.setPRNG((x, n) => {
    const bytes = Crypto.getRandomBytes(n);
    for (let i = 0; i < n; i++) x[i] = bytes[i];
});

export default nacl;
