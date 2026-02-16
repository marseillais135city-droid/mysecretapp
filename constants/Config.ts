import Constants from 'expo-constants';

const SERVER_PORT = 3000;

// En production, remplace par ton domaine : "https://tondomaine.com"
const PRODUCTION_URL = "https://mysecret-server.onrender.com";

// En dev, on tolère HTTP pour le réseau local uniquement
const __DEV_MODE__ = __DEV__;

export const getServerURL = async () => {
    // 1. Production : si une URL est définie, l'utiliser (doit être HTTPS)
    if (PRODUCTION_URL) {
        if (!PRODUCTION_URL.startsWith('https://')) {
            console.warn('[CONFIG] PRODUCTION_URL doit utiliser HTTPS !');
        }
        return PRODUCTION_URL;
    }

    // 2. Dev : auto-détection via Expo (même IP que le bundler)
    const debuggerHost = Constants.expoConfig?.hostUri; // e.g. "192.168.1.37:8081"
    if (debuggerHost) {
        const ip = debuggerHost.split(':')[0];
        // HTTP toléré uniquement en dev local
        const protocol = __DEV_MODE__ ? 'http' : 'https';
        return `${protocol}://${ip}:${SERVER_PORT}`;
    }

    // 3. Fallback localhost (dev uniquement)
    const protocol = __DEV_MODE__ ? 'http' : 'https';
    return `${protocol}://localhost:${SERVER_PORT}`;
};

export const getServerIP = async () => {
    const url = await getServerURL();
    return url.replace(/^https?:\/\//, '').split(':')[0];
};
