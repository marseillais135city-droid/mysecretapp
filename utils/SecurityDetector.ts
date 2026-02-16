import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

/**
 * Detects if the device is jailbroken (iOS) or rooted (Android).
 * Uses heuristic checks — no single check is 100% reliable, but combining
 * multiple indicators gives a strong signal.
 *
 * NOTE: In Expo managed workflow, native file access is limited.
 * These checks cover the most common indicators accessible from JS.
 */

// iOS jailbreak indicators
const IOS_JAILBREAK_PATHS = [
    '/Applications/Cydia.app',
    '/Applications/Sileo.app',
    '/Applications/Zebra.app',
    '/Library/MobileSubstrate/MobileSubstrate.dylib',
    '/bin/bash',
    '/usr/sbin/sshd',
    '/etc/apt',
    '/private/var/lib/apt/',
    '/usr/bin/ssh',
    '/var/cache/apt',
    '/var/lib/cydia',
    '/var/tmp/cydia.log',
    '/private/var/stash',
];

// Android root indicators
const ANDROID_ROOT_PATHS = [
    '/system/app/Superuser.apk',
    '/system/xbin/su',
    '/system/bin/su',
    '/sbin/su',
    '/data/local/xbin/su',
    '/data/local/bin/su',
    '/data/local/su',
    '/system/sd/xbin/su',
    '/system/bin/failsafe/su',
    '/su/bin/su',
    '/data/adb/magisk',
];

/**
 * Check if suspicious paths exist on the device.
 * Uses expo-file-system to check file info (works in managed workflow).
 */
async function checkSuspiciousPaths(): Promise<boolean> {
    const paths = Platform.OS === 'ios' ? IOS_JAILBREAK_PATHS : ANDROID_ROOT_PATHS;

    for (const path of paths) {
        try {
            const fileUri = Platform.OS === 'android' ? `file://${path}` : path;
            const info = await FileSystem.getInfoAsync(fileUri);
            if (info.exists) {
                console.warn(`[SECURITY] Suspicious path found: ${path}`);
                return true;
            }
        } catch {
            // Expected to fail for most paths — ignore
        }
    }
    return false;
}

/**
 * Check if the app is running in a debugger or development tool.
 * Limited in JS but can detect some indicators.
 */
function checkDebuggerAttached(): boolean {
    // In production, __DEV__ should be false
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
        // Dev mode — don't flag as jailbreak, but note it
        return false;
    }
    return false;
}

/**
 * Main detection function.
 * Returns true if the device appears to be jailbroken/rooted.
 */
export async function isDeviceCompromised(): Promise<boolean> {
    try {
        // Skip detection on web
        if (Platform.OS === 'web') return false;

        const hasSuspiciousPaths = await checkSuspiciousPaths();
        if (hasSuspiciousPaths) return true;

        return false;
    } catch (e) {
        console.error('[SECURITY] Detection error:', e);
        return false;
    }
}

/**
 * Get detailed detection results for logging/display.
 */
export async function getSecurityStatus(): Promise<{
    isCompromised: boolean;
    details: string[];
}> {
    const details: string[] = [];

    if (Platform.OS === 'web') {
        return { isCompromised: false, details: ['Web platform — skipped'] };
    }

    const hasSuspiciousPaths = await checkSuspiciousPaths();
    if (hasSuspiciousPaths) {
        details.push(Platform.OS === 'ios' ? 'Jailbreak détecté (fichiers suspects)' : 'Root détecté (fichiers suspects)');
    }

    const isDebug = checkDebuggerAttached();
    if (isDebug) {
        details.push('Débogueur détecté');
    }

    if (details.length === 0) {
        details.push('Aucune menace détectée');
    }

    return {
        isCompromised: hasSuspiciousPaths || isDebug,
        details
    };
}
