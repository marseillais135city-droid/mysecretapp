
import { useTheme } from '@/context/ThemeContext';
import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import React, { useEffect, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

const APP_LOCK_KEY = "my_app_lock_pin_v1";

interface LockScreenProps {
    onUnlock: () => void;
    isSetup?: boolean;
    onCancel?: () => void;
}

type LockType = 'pin4' | 'pin6' | 'password';

// ─── PIN Hashing (iterated SHA-256 with domain separation) ──────
const HASH_ITERATIONS = 50000;
async function hashPin(pin: string, salt: string, iterations: number = HASH_ITERATIONS): Promise<string> {
    // HMAC-like construction with domain separator
    let hash = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        `ghost:pin:v2:${salt}:${pin}`
    );
    for (let i = 0; i < iterations; i++) {
        hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, hash + salt);
    }
    return hash;
}

// Legacy hash for migration
async function hashPinLegacy(pin: string, salt: string): Promise<string> {
    let hash = salt + pin;
    for (let i = 0; i < 10000; i++) {
        hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, hash);
    }
    return hash;
}

function generateSalt(): string {
    const bytes = Crypto.getRandomBytes(16);
    return Array.from(bytes).map(b => ('00' + b.toString(16)).slice(-2)).join('');
}

// ─── Brute-force delay calculation (exponential backoff) ────────
const FAILED_ATTEMPTS_KEY = "ghost_lock_failed_attempts";

function getDelay(failedAttempts: number): number {
    if (failedAttempts >= 15) return 300; // 5 min
    if (failedAttempts >= 10) return 120; // 2 min
    if (failedAttempts >= 7) return 60;
    if (failedAttempts >= 5) return 30;
    if (failedAttempts >= 3) return 10;
    return 0;
}

async function loadFailedAttempts(): Promise<number> {
    try {
        const stored = await SecureStore.getItemAsync(FAILED_ATTEMPTS_KEY);
        if (stored) return parseInt(stored) || 0;
    } catch { }
    return 0;
}

async function saveFailedAttempts(count: number): Promise<void> {
    try {
        await SecureStore.setItemAsync(FAILED_ATTEMPTS_KEY, count.toString());
    } catch { }
}

async function clearFailedAttempts(): Promise<void> {
    try {
        await SecureStore.deleteItemAsync(FAILED_ATTEMPTS_KEY);
    } catch { }
}

export default function LockScreen({ onUnlock, isSetup = false, onCancel }: LockScreenProps) {
    const { colors } = useTheme();
    const [pin, setPin] = useState("");
    const [confirmPin, setConfirmPin] = useState("");
    const [step, setStep] = useState(isSetup ? "type_selection" : "unlock");
    const [error, setError] = useState("");
    const [lockType, setLockType] = useState<LockType>('pin4');
    const [failedAttempts, setFailedAttempts] = useState(0);
    const [cooldownRemaining, setCooldownRemaining] = useState(0);
    const cooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        if (!isSetup) {
            loadPersistedState();
            checkBiometrics();
            loadLockType();
        }
        return () => {
            if (cooldownTimer.current) clearInterval(cooldownTimer.current);
        };
    }, []);

    const loadPersistedState = async () => {
        const persistedFailed = await loadFailedAttempts();
        if (persistedFailed > 0) {
            setFailedAttempts(persistedFailed);
            const delay = getDelay(persistedFailed);
            if (delay > 0) {
                setError(`Trop de tentatives. Attente ${delay}s...`);
                startCooldown(delay);
            }
        }
    };

    const loadLockType = async () => {
        const storedValue = await SecureStore.getItemAsync(APP_LOCK_KEY);
        if (storedValue) {
            try {
                const parsed = JSON.parse(storedValue);
                if (parsed.type) setLockType(parsed.type);
            } catch (e) {
                setLockType('pin4');
            }
        }
    };

    const checkBiometrics = async () => {
        const hasHardware = await LocalAuthentication.hasHardwareAsync();
        const isEnrolled = await LocalAuthentication.isEnrolledAsync();
        if (hasHardware && isEnrolled) {
            const result = await LocalAuthentication.authenticateAsync({
                promptMessage: 'Déverrouiller MySecretApp',
                fallbackLabel: 'Utiliser le code',
            });
            if (result.success) {
                onUnlock();
            }
        }
    };

    const startCooldown = (seconds: number) => {
        setCooldownRemaining(seconds);
        if (cooldownTimer.current) clearInterval(cooldownTimer.current);
        cooldownTimer.current = setInterval(() => {
            setCooldownRemaining(prev => {
                if (prev <= 1) {
                    if (cooldownTimer.current) clearInterval(cooldownTimer.current);
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);
    };

    const handlePress = (num: string) => {
        if (lockType === 'password') return;
        if (cooldownRemaining > 0) return;

        const maxLength = lockType === 'pin6' ? 6 : 4;
        if (pin.length < maxLength) {
            const newPin = pin + num;
            setPin(newPin);
            setError("");

            if (newPin.length === maxLength) {
                handleComplete(newPin);
            }
        }
    };

    const handleDelete = () => {
        setPin(pin.slice(0, -1));
        setError("");
    };

    const handleComplete = async (enteredInput: string) => {
        if (step === "unlock") {
            if (cooldownRemaining > 0) return;

            const storedValue = await SecureStore.getItemAsync(APP_LOCK_KEY);
            let valid = false;

            try {
                const parsed = JSON.parse(storedValue || "");

                if (parsed.hash && parsed.salt) {
                    // Current hashed format
                    const computedHash = await hashPin(enteredInput, parsed.salt);
                    if (computedHash === parsed.hash) {
                        valid = true;
                    } else {
                        // Try legacy hash for migration (old iterations/format)
                        const legacyHash = await hashPinLegacy(enteredInput, parsed.salt);
                        if (legacyHash === parsed.hash) {
                            valid = true;
                            // Auto-migrate to new hash format
                            const newSalt = generateSalt();
                            const newHash = await hashPin(enteredInput, newSalt);
                            const migrated = JSON.stringify({ type: parsed.type || lockType, hash: newHash, salt: newSalt });
                            await SecureStore.setItemAsync(APP_LOCK_KEY, migrated);
                        }
                    }
                }
                // Legacy plaintext formats removed for security
            } catch (e) {
                // Parse error - invalid stored data
                valid = false;
            }

            if (valid) {
                setFailedAttempts(0);
                await clearFailedAttempts();
                onUnlock();
            } else {
                const newFailed = failedAttempts + 1;
                setFailedAttempts(newFailed);
                await saveFailedAttempts(newFailed); // Persist across restarts
                const delay = getDelay(newFailed);

                if (delay > 0) {
                    setError(`Code incorrect. Attente ${delay}s...`);
                    startCooldown(delay);
                } else {
                    setError("Code incorrect");
                }

                setPin("");
            }
        } else if (step === "create") {
            setConfirmPin(enteredInput);
            setPin("");
            setStep("confirm");
        } else if (step === "confirm") {
            if (enteredInput === confirmPin) {
                const salt = generateSalt();
                const hash = await hashPin(enteredInput, salt);
                const data = JSON.stringify({ type: lockType, hash, salt });
                await SecureStore.setItemAsync(APP_LOCK_KEY, data);
                Alert.alert("Succès", "Verrouillage activé !");
                onUnlock();
            } else {
                setError("Les codes ne correspondent pas");
                setPin("");
                setStep("create");
                setConfirmPin("");
            }
        }
    };

    const getTitle = () => {
        if (step === "unlock") return "SECRET";
        if (step === "type_selection") return "Type de verrouillage";
        if (step === "create") return "Créer le code";
        if (step === "confirm") return "Confirmer le code";
        return "";
    };

    const styles = getStyles(colors);

    if (step === "type_selection") {
        return (
            <View style={[StyleSheet.absoluteFill, styles.container]}>
                <Text style={styles.title}>Choisissez le type de sécurité</Text>

                <TouchableOpacity style={styles.optionButton} onPress={() => { setLockType('pin4'); setStep('create'); }}>
                    <Text style={styles.optionText}>Code PIN 4 chiffres</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.optionButton} onPress={() => { setLockType('pin6'); setStep('create'); }}>
                    <Text style={styles.optionText}>Code PIN 6 chiffres</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.optionButton} onPress={() => { setLockType('password'); setStep('create'); }}>
                    <Text style={styles.optionText}>Mot de passe alphanumérique</Text>
                </TouchableOpacity>

                {onCancel && (
                    <TouchableOpacity onPress={onCancel} style={{ marginTop: 20 }}>
                        <Text style={{ color: colors.textSecondary }}>Annuler</Text>
                    </TouchableOpacity>
                )}
            </View>
        );
    }

    const isPinMode = lockType === 'pin4' || lockType === 'pin6';
    const maxLength = lockType === 'pin6' ? 6 : 4;

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={[StyleSheet.absoluteFill, styles.container]}
        >
            <Text style={[styles.title, step === "unlock" && { fontSize: 40, letterSpacing: 5, marginBottom: 60 }]}>
                {getTitle()}
            </Text>

            {isPinMode ? (
                <>
                    <View style={{ flexDirection: 'row', marginBottom: 50 }}>
                        {[...Array(maxLength)].map((_, i) => (
                            <View key={i} style={{
                                width: 20, height: 20, borderRadius: 10,
                                backgroundColor: i < pin.length ? colors.primary : colors.surface,
                                borderWidth: 1, borderColor: colors.secondary,
                                marginHorizontal: 5
                            }} />
                        ))}
                    </View>

                    {error ? <Text style={{ color: colors.error, marginBottom: 10, textAlign: 'center' }}>{error}</Text> : null}
                    {cooldownRemaining > 0 && (
                        <Text style={{ color: colors.error, marginBottom: 20, fontSize: 18, fontWeight: 'bold' }}>
                            {cooldownRemaining}s
                        </Text>
                    )}

                    <View style={{ width: '80%', maxWidth: 300, opacity: cooldownRemaining > 0 ? 0.4 : 1 }}>
                        <View style={styles.row}>
                            {['1', '2', '3'].map((n) => <Key key={n} num={n} onPress={handlePress} colors={colors} />)}
                        </View>
                        <View style={styles.row}>
                            {['4', '5', '6'].map((n) => <Key key={n} num={n} onPress={handlePress} colors={colors} />)}
                        </View>
                        <View style={styles.row}>
                            {['7', '8', '9'].map((n) => <Key key={n} num={n} onPress={handlePress} colors={colors} />)}
                        </View>
                        <View style={styles.row}>
                            <View style={styles.keyPlaceholder} />
                            <Key num="0" onPress={handlePress} colors={colors} />
                            <TouchableOpacity onPress={handleDelete} style={[styles.key, { backgroundColor: 'transparent', borderWidth: 0 }]}>
                                <Ionicons name="backspace-outline" size={28} color={colors.text} />
                            </TouchableOpacity>
                        </View>
                    </View>
                </>
            ) : (
                <View style={{ width: '80%' }}>
                    <TextInput
                        style={{
                            backgroundColor: colors.surface, padding: 15, borderRadius: 10,
                            borderWidth: 1, borderColor: colors.border, marginBottom: 20,
                            fontSize: 18, color: colors.text, textAlign: 'center'
                        }}
                        placeholder="Mot de passe"
                        placeholderTextColor={colors.textSecondary}
                        secureTextEntry
                        value={pin}
                        onChangeText={setPin}
                        autoFocus
                        editable={cooldownRemaining === 0}
                        onSubmitEditing={() => cooldownRemaining === 0 && handleComplete(pin)}
                    />
                    {error ? <Text style={{ color: colors.error, marginBottom: 10, textAlign: 'center' }}>{error}</Text> : null}
                    {cooldownRemaining > 0 && (
                        <Text style={{ color: colors.error, marginBottom: 20, textAlign: 'center', fontSize: 18, fontWeight: 'bold' }}>
                            Attente : {cooldownRemaining}s
                        </Text>
                    )}

                    <TouchableOpacity
                        onPress={() => handleComplete(pin)}
                        disabled={cooldownRemaining > 0}
                        style={{ backgroundColor: cooldownRemaining > 0 ? colors.textSecondary : colors.primary, padding: 15, borderRadius: 10, alignItems: 'center' }}
                    >
                        <Text style={{ color: 'white', fontWeight: 'bold' }}>Valider</Text>
                    </TouchableOpacity>
                </View>
            )}

            {onCancel && step !== 'unlock' && (
                <TouchableOpacity onPress={onCancel} style={{ marginTop: 40 }}>
                    <Text style={{ color: colors.textSecondary, fontSize: 16 }}>Annuler</Text>
                </TouchableOpacity>
            )}
        </KeyboardAvoidingView>
    );
}

const Key = ({ num, onPress, colors }: { num: string, onPress: (n: string) => void, colors: any }) => (
    <TouchableOpacity onPress={() => onPress(num)} style={{
        width: 70, height: 70,
        borderRadius: 35,
        backgroundColor: colors.surface,
        justifyContent: 'center', alignItems: 'center',
        borderWidth: 1, borderColor: colors.border
    }}>
        <Text style={{
            fontSize: 28,
            color: colors.text,
            fontWeight: '500'
        }}>{num}</Text>
    </TouchableOpacity>
);

const getStyles = (colors: any) => StyleSheet.create({
    container: {
        backgroundColor: colors.background,
        zIndex: 9999,
        justifyContent: 'center',
        alignItems: 'center'
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        color: colors.text,
        marginBottom: 10
    },
    row: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: 20,
    },
    key: {
        width: 70, height: 70,
        borderRadius: 35,
        backgroundColor: colors.surface,
        justifyContent: 'center', alignItems: 'center',
        borderWidth: 1, borderColor: colors.border
    },
    keyPlaceholder: {
        width: 70, height: 70
    },
    optionButton: {
        backgroundColor: colors.surface,
        padding: 20,
        borderRadius: 15,
        borderWidth: 1,
        borderColor: colors.border,
        marginBottom: 15,
        width: '80%',
        alignItems: 'center'
    },
    optionText: {
        fontSize: 18,
        color: colors.text,
        fontWeight: '500'
    }
});
