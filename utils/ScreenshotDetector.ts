import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

/**
 * Screenshot detection utility.
 *
 * On iOS: Uses the native `UIApplicationUserDidTakeScreenshotNotification`
 * via expo-screen-capture (if available) or a polling fallback.
 *
 * On Android: Same approach via expo-screen-capture.
 *
 * Since we're in Expo managed workflow, we use `expo-screen-capture`
 * which provides addScreenshotListener().
 */

let screenshotListenerSubscription: any = null;

type ScreenshotCallback = () => void;

/**
 * Start listening for screenshots.
 * Calls the callback whenever a screenshot is detected.
 * Returns an unsubscribe function.
 */
export async function startScreenshotDetection(
    onScreenshot: ScreenshotCallback
): Promise<() => void> {
    if (Platform.OS === 'web') {
        return () => {}; // No-op on web
    }

    try {
        // Try to use expo-screen-capture
        const ScreenCapture = require('expo-screen-capture');

        if (ScreenCapture && ScreenCapture.addScreenshotListener) {
            screenshotListenerSubscription = ScreenCapture.addScreenshotListener(() => {
                onScreenshot();
            });

            return () => {
                if (screenshotListenerSubscription) {
                    screenshotListenerSubscription.remove();
                    screenshotListenerSubscription = null;
                }
            };
        }
    } catch (e) {
        console.warn('[SCREENSHOT] expo-screen-capture not available, screenshot detection disabled');
    }

    return () => {}; // Fallback no-op
}

/**
 * Prevent screenshots by enabling screen capture protection.
 * On iOS: Prevents screen recording/screenshots.
 * On Android: Adds FLAG_SECURE to prevent screenshots.
 */
export async function preventScreenCapture(): Promise<void> {
    if (Platform.OS === 'web') return;

    try {
        const ScreenCapture = require('expo-screen-capture');
        if (ScreenCapture && ScreenCapture.preventScreenCaptureAsync) {
            await ScreenCapture.preventScreenCaptureAsync();
        }
    } catch (e) {
        console.warn('[SCREENSHOT] Cannot prevent screen capture:', e);
    }
}

/**
 * Allow screenshots again (re-enable screen capture).
 */
export async function allowScreenCapture(): Promise<void> {
    if (Platform.OS === 'web') return;

    try {
        const ScreenCapture = require('expo-screen-capture');
        if (ScreenCapture && ScreenCapture.allowScreenCaptureAsync) {
            await ScreenCapture.allowScreenCaptureAsync();
        }
    } catch (e) {
        console.warn('[SCREENSHOT] Cannot allow screen capture:', e);
    }
}

/**
 * React hook for screenshot detection.
 * Usage: useScreenshotDetection(isEnabled, onScreenshotDetected)
 */
export function useScreenshotDetection(
    enabled: boolean,
    onScreenshot: ScreenshotCallback
) {
    const callbackRef = useRef(onScreenshot);
    callbackRef.current = onScreenshot;

    useEffect(() => {
        if (!enabled || Platform.OS === 'web') return;

        let unsubscribe: (() => void) | null = null;

        startScreenshotDetection(() => {
            callbackRef.current();
        }).then(unsub => {
            unsubscribe = unsub;
        });

        return () => {
            if (unsubscribe) unsubscribe();
        };
    }, [enabled]);
}
