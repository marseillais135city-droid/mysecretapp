import { GhostStyles } from '@/components/GhostTheme';
import LockScreen from '@/components/LockScreen';
import { getServerURL } from '@/constants/Config';
import { useTheme } from '@/context/ThemeContext';
import { authFetch, clearAuthCache, getMyID } from '@/utils/AuthHelper';
import { clearSecureStorageCache, secureGet, secureSet } from '@/utils/SecureStorage';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { useFocusEffect, useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import * as Updates from 'expo-updates';
import React, { useCallback, useState } from 'react';
import { Alert, Image, Modal, ScrollView, Switch, Text, TouchableOpacity, View } from 'react-native';

const APP_LOCK_KEY = "my_app_lock_pin_v1";

const CONTACTS_KEY = "my_contacts_list_v1";
const PROFILE_KEY = "my_profile_data_v1";
const STORAGE_KEY = "my_permanent_secret_key_v1";

export default function SettingsScreen() {
    const { theme, setTheme, colors } = useTheme();
    const router = useRouter();
    const [blockedContacts, setBlockedContacts] = useState<any[]>([]);
    const [readReceipts, setReadReceipts] = useState(true);
    const [onlineStatus, setOnlineStatus] = useState(true);
    const [isAppLocked, setIsAppLocked] = useState(false);
    const [showLockSetup, setShowLockSetup] = useState(false);
    const [userProfile, setUserProfile] = useState({ pseudo: "Mon Profil", avatar: null });

    const [showLockVerify, setShowLockVerify] = useState(false);
    const [nextAction, setNextAction] = useState<'disable' | 'modify' | 'delete' | null>(null);
    const [autoDeleteDelay, setAutoDeleteDelay] = useState<number | null>(null);
    const [showAutoDeleteModal, setShowAutoDeleteModal] = useState(false);
    const [screenshotDetection, setScreenshotDetection] = useState(false);

    useFocusEffect(
        useCallback(() => {
            loadSettings();
        }, [])
    );

    const loadSettings = async () => {
        try {
            // Load Blocked
            const contactsJson = await secureGet(CONTACTS_KEY);
            if (contactsJson) {
                const list = JSON.parse(contactsJson);
                setBlockedContacts(list.filter((c: any) => c.isBlocked));
            }

            // Load Privacy settings from SecureStore
            const rr = await SecureStore.getItemAsync("privacy_read_receipts");
            setReadReceipts(rr !== "false");

            const os = await SecureStore.getItemAsync("privacy_online_status");
            setOnlineStatus(os !== "false");

            const storedValue = await SecureStore.getItemAsync(APP_LOCK_KEY);
            setIsAppLocked(!!storedValue);

            const delay = await SecureStore.getItemAsync("security_auto_delete_delay");
            if (delay) setAutoDeleteDelay(parseInt(delay));

            const ss = await SecureStore.getItemAsync("security_screenshot_detection");
            setScreenshotDetection(ss === "true");

            // Load Own Profile
            const profileJson = await secureGet(PROFILE_KEY);
            if (profileJson) {
                const p = JSON.parse(profileJson);
                setUserProfile({ pseudo: p.pseudo, avatar: p.avatar });
            }
        } catch (e) {
            console.error("Failed to load settings", e);
        }
    };

    const toggleSystemTheme = (value: boolean) => {
        setTheme(value ? 'system' : 'light');
    };

    const toggleDarkTheme = (value: boolean) => {
        setTheme(value ? 'dark' : 'light');
    };

    const toggleReadReceipts = async (value: boolean) => {
        setReadReceipts(value);
        await SecureStore.setItemAsync("privacy_read_receipts", value ? "true" : "false");
    };

    const toggleOnlineStatus = async (value: boolean) => {
        setOnlineStatus(value);
        await SecureStore.setItemAsync("privacy_online_status", value ? "true" : "false");
    };

    const handleLockToggle = async (value: boolean) => {
        if (value) {
            // Enable
            setShowLockSetup(true);
        } else {
            // Disable - Require verification
            setNextAction('disable');
            setShowLockVerify(true);
        }
    };

    const handleModifyLock = () => {
        setNextAction('modify');
        setShowLockVerify(true);
    };

    const onVerifySuccess = async () => {
        setShowLockVerify(false);
        if (nextAction === 'disable') {
            await SecureStore.deleteItemAsync(APP_LOCK_KEY);
            setIsAppLocked(false);
            setNextAction(null);
            Alert.alert("Succès", "Verrouillage désactivé.");
        } else if (nextAction === 'modify') {
            setShowLockSetup(true);
            setNextAction(null);
        } else if (nextAction === 'delete') {
            setNextAction(null);
            performFinalWipe();
        }
    };

    const unblockContact = async (id: string) => {
        try {
            const json = await secureGet(CONTACTS_KEY);
            if (json) {
                let list = JSON.parse(json);
                list = list.map((c: any) => {
                    if (c.id === id) return { ...c, isBlocked: false };
                    return c;
                });
                await secureSet(CONTACTS_KEY, JSON.stringify(list));
                setBlockedContacts(list.filter((c: any) => c.isBlocked));
                Alert.alert("Succès", "Contact débloqué.");
            }
        } catch (e) {
            Alert.alert("Erreur", "Action impossible.");
        }
    };

    const toggleScreenshotDetection = async (value: boolean) => {
        setScreenshotDetection(value);
        await SecureStore.setItemAsync("security_screenshot_detection", value ? "true" : "false");
    };

    const handleAutoDeleteChange = async (value: number | null) => {
        try {
            if (value === null) {
                await SecureStore.deleteItemAsync("security_auto_delete_delay");
            } else {
                await SecureStore.setItemAsync("security_auto_delete_delay", value.toString());
            }
            setAutoDeleteDelay(value);
            setShowAutoDeleteModal(false);
        } catch (e) {
            console.error("Failed to save auto delete delay", e);
        }
    };

    const getAutoDeleteLabel = () => {
        if (!autoDeleteDelay) return "Jamais";
        if (autoDeleteDelay === 60 * 1000) return "1 minute";
        if (autoDeleteDelay === 24 * 60 * 60 * 1000) return "24 heures";
        if (autoDeleteDelay === 7 * 24 * 60 * 60 * 1000) return "1 semaine";
        if (autoDeleteDelay === 30 * 24 * 60 * 60 * 1000) return "30 jours";
        return "Personnalisé";
    };

    const clearHistory = async () => {
        Alert.alert(
            "Vider les discussions",
            "Voulez-vous vraiment supprimer tout l'historique des messages ? Cette action est irréversible.",
            [
                { text: "Annuler", style: "cancel" },
                {
                    text: "Vider",
                    style: "destructive",
                    onPress: async () => {
                        try {
                            const keys = await AsyncStorage.getAllKeys();
                            const historyKeys = keys.filter(k => k.startsWith("history_") || k.startsWith("last_read_"));
                            await AsyncStorage.multiRemove(historyKeys);
                            Alert.alert("Succès", "Historique vidé.");
                        } catch (e) {
                            Alert.alert("Erreur", "Action impossible.");
                        }
                    }
                }
            ]
        );
    };

    const clearMediaCache = async () => {
        try {
            const cacheDir = FileSystem.cacheDirectory;
            if (cacheDir) {
                const files = await FileSystem.readDirectoryAsync(cacheDir);
                for (const file of files) {
                    await FileSystem.deleteAsync(cacheDir + file, { idempotent: true });
                }
            }
            Alert.alert("Succès", "Cache des médias vidé.");
        } catch (e) {
            Alert.alert("Erreur", "Impossible de vider le cache.");
        }
    };

    const deleteAccount = async () => {
        Alert.alert(
            "Zone Danger",
            "Cette action est irréversible. Tout sera effacé (messages, contacts, identité).",
            [
                { text: "Annuler", style: "cancel" },
                {
                    text: "TOUT EFFACER",
                    style: "destructive",
                    onPress: async () => {
                        const storedPin = await SecureStore.getItemAsync(APP_LOCK_KEY);
                        if (storedPin) {
                            setNextAction('delete');
                            setShowLockVerify(true);
                        } else {
                            performFinalWipe();
                        }
                    }
                }
            ]
        );
    };

    const performFinalWipe = async () => {
        try {
            // Notify server before wiping local data
            try {
                const myID = await getMyID();
                if (myID) {
                    const serverURL = await getServerURL();
                    await authFetch(`${serverURL}/delete-account`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: myID })
                    });
                }
            } catch (e) {
                console.error("Failed to notify server of deletion", e);
            }

            // Clear caches
            clearAuthCache();
            clearSecureStorageCache();

            await AsyncStorage.clear();
            await SecureStore.deleteItemAsync(STORAGE_KEY);
            await SecureStore.deleteItemAsync(APP_LOCK_KEY);
            await SecureStore.deleteItemAsync("privacy_read_receipts");
            await SecureStore.deleteItemAsync("privacy_online_status");
            await SecureStore.deleteItemAsync("security_last_active_timestamp");
            await SecureStore.deleteItemAsync("security_auto_delete_delay");
            await SecureStore.deleteItemAsync("ghost_lock_failed_attempts");
            await SecureStore.deleteItemAsync("security_screenshot_detection");
            Alert.alert("Terminé", "Votre compte a été supprimé.");
            await Updates.reloadAsync();
        } catch (e) {
            Alert.alert("Erreur", "Une erreur est survenue lors de la suppression.");
        }
    };

    const SettingSection = ({ title, children, colors }: { title: string, children: React.ReactNode, colors: any }) => (
        <View style={{ width: '100%', marginBottom: 30 }}>
            <Text style={[GhostStyles.label, { marginLeft: 10, marginBottom: 10, color: colors.textSecondary }]}>{title}</Text>
            <View style={{ backgroundColor: colors.surface, borderRadius: 15, overflow: 'hidden', borderWidth: 1, borderColor: colors.border }}>
                {children}
            </View>
        </View>
    );

    const SettingItem = ({ label, children, last, colors }: { label: string, children: React.ReactNode, last?: boolean, colors: any }) => (
        <View style={{
            flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
            padding: 15, borderBottomWidth: last ? 0 : 1, borderBottomColor: colors.border
        }}>
            <Text style={{ fontSize: 16, color: colors.text }}>{label}</Text>
            {children}
        </View>
    );

    return (
        <View style={[GhostStyles.container, { backgroundColor: colors.background }]}>
            <View style={[GhostStyles.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
                <Text style={[GhostStyles.headerTitle, { color: colors.text }]}>Réglages</Text>
            </View>

            <ScrollView contentContainerStyle={{ padding: 20 }}>
                {/* PROFIL */}
                <TouchableOpacity
                    style={{
                        flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
                        padding: 15, borderRadius: 15, marginBottom: 30, borderWidth: 1, borderColor: colors.border
                    }}
                    onPress={() => router.push('/(tabs)/profile')}
                >
                    <View style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: colors.border, justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }}>
                        {userProfile.avatar ? (
                            <Image source={{ uri: userProfile.avatar }} style={{ width: '100%', height: '100%' }} />
                        ) : (
                            <Text style={{ fontSize: 30 }}>👤</Text>
                        )}
                    </View>
                    <View style={{ marginLeft: 15 }}>
                        <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.text }}>{userProfile.pseudo}</Text>
                        <Text style={{ fontSize: 14, color: colors.textSecondary }}>Modifier mon profil ›</Text>
                    </View>
                </TouchableOpacity>

                <SettingSection title="APPARENCE" colors={colors}>
                    <SettingItem label="Mode Sombre" last colors={colors}>
                        <Switch
                            value={theme === 'dark'}
                            onValueChange={(val) => setTheme(val ? 'dark' : 'light')}
                            trackColor={{ false: "#767577", true: colors.primary }}
                            thumbColor={theme === 'dark' ? colors.primary : '#f4f3f4'}
                        />
                    </SettingItem>
                </SettingSection>

                {/* CONFIDENTIALITE */}
                <SettingSection title="SÉCURITÉ ET DONNÉES" colors={colors}>
                    <SettingItem label="Confirmation de lecture" colors={colors}>
                        <Switch
                            value={readReceipts}
                            onValueChange={toggleReadReceipts}
                            trackColor={{ false: "#767577", true: colors.primary }}
                            thumbColor={readReceipts ? colors.primary : '#f4f3f4'}
                        />
                    </SettingItem>
                    <SettingItem label="Statut En ligne" colors={colors}>
                        <Switch
                            value={onlineStatus}
                            onValueChange={toggleOnlineStatus}
                            trackColor={{ false: "#767577", true: colors.primary }}
                            thumbColor={onlineStatus ? colors.primary : '#f4f3f4'}
                        />
                    </SettingItem>
                    <SettingItem label="Verrouillage par Code" last={!isAppLocked} colors={colors}>
                        <Switch
                            value={isAppLocked}
                            onValueChange={handleLockToggle}
                            trackColor={{ false: "#767577", true: colors.primary }}
                            thumbColor={isAppLocked ? colors.primary : '#f4f3f4'}
                        />
                    </SettingItem>

                    {isAppLocked && (
                        <TouchableOpacity onPress={handleModifyLock}>
                            <SettingItem label="Modifier le code" last={false} colors={colors}>
                                <Text style={{ color: colors.primary, fontSize: 14 }}>Modifier ›</Text>
                            </SettingItem>
                        </TouchableOpacity>
                    )}

                    <TouchableOpacity onPress={() => setShowAutoDeleteModal(true)}>
                        <SettingItem label="Auto-suppression si inactif" colors={colors}>
                            <Text style={{ color: colors.textSecondary, fontSize: 14 }}>{getAutoDeleteLabel()} ›</Text>
                        </SettingItem>
                    </TouchableOpacity>

                    <SettingItem label="Bloquer les captures d'écran" last colors={colors}>
                        <Switch
                            value={screenshotDetection}
                            onValueChange={toggleScreenshotDetection}
                            trackColor={{ false: "#767577", true: colors.primary }}
                            thumbColor={screenshotDetection ? colors.primary : '#f4f3f4'}
                        />
                    </SettingItem>
                </SettingSection>

                {/* LISTE NOIRE */}
                <SettingSection title="LISTE NOIRE" colors={colors}>
                    <View style={{ padding: 15 }}>
                        <Text style={{ fontSize: 16, color: colors.text, marginBottom: 10 }}>Utilisateurs bloqués</Text>
                        {blockedContacts.length > 0 ? (
                            blockedContacts.map((c, index) => (
                                <View key={c.id} style={{
                                    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                                    paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border
                                }}>
                                    <Text style={{ color: colors.text }}>{c.alias || c.name}</Text>
                                    <TouchableOpacity onPress={() => unblockContact(c.id)}>
                                        <Text style={{ color: colors.primary, fontWeight: 'bold' }}>Débloquer</Text>
                                    </TouchableOpacity>
                                </View>
                            ))
                        ) : (
                            <Text style={{ color: colors.textSecondary, fontSize: 14, fontStyle: 'italic' }}>Aucun utilisateur bloqué.</Text>
                        )}
                    </View>
                </SettingSection>

                {/* STOCKAGE */}
                <SettingSection title="STOCKAGE ET DONNÉES" colors={colors}>
                    <TouchableOpacity onPress={clearHistory}>
                        <SettingItem label="Vider toutes les discussions" colors={colors}>
                            <Text style={{ color: '#FF3B30', fontSize: 14 }}>Effacer</Text>
                        </SettingItem>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={clearMediaCache}>
                        <SettingItem label="Effacer le cache des médias" last colors={colors}>
                            <Text style={{ color: colors.textSecondary, fontSize: 14 }}>Nettoyer</Text>
                        </SettingItem>
                    </TouchableOpacity>
                </SettingSection>

                {/* AIDE */}
                <SettingSection title="À PROPOS" colors={colors}>
                    <SettingItem label="Version" colors={colors}>
                        <Text style={{ color: colors.textSecondary }}>1.2.0 (Ghost Proto)</Text>
                    </SettingItem>
                    <SettingItem label="Ghost Signal Protocol" last colors={colors}>
                        <Text style={{ color: colors.primary }}>Actif 🛡️</Text>
                    </SettingItem>
                </SettingSection>

                <TouchableOpacity
                    onPress={deleteAccount}
                    style={{
                        width: '100%', padding: 15, borderRadius: 12,
                        backgroundColor: '#FF3B30', alignItems: 'center', marginTop: 10
                    }}
                >
                    <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 16 }}>SUPPRIMER MON COMPTE</Text>
                </TouchableOpacity>

                <View style={{ height: 100 }} />
            </ScrollView>

            {showLockVerify && (
                <LockScreen
                    onUnlock={onVerifySuccess}
                    onCancel={() => {
                        setShowLockVerify(false);
                        setNextAction(null);
                    }}
                />
            )}

            {showLockSetup && (
                <LockScreen
                    onUnlock={() => {
                        setShowLockSetup(false);
                        setIsAppLocked(true);
                    }}
                    isSetup={true}
                    onCancel={() => {
                        setShowLockSetup(false);
                    }}
                />
            )}

            <Modal
                visible={showAutoDeleteModal}
                transparent={true}
                animationType="fade"
                onRequestClose={() => setShowAutoDeleteModal(false)}
            >
                <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' }}>
                    <View style={{ width: '80%', backgroundColor: colors.surface, borderRadius: 20, padding: 20, alignItems: 'center' }}>
                        <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.text, marginBottom: 20 }}>Auto-suppression</Text>
                        <Text style={{ color: colors.textSecondary, textAlign: 'center', marginBottom: 20 }}>
                            Si vous n'ouvrez pas l'application pendant cette durée, tout votre compte sera effacé.
                        </Text>

                        {[
                            { label: "Jamais", value: null },
                            { label: "1 minute (Test)", value: 60 * 1000 },
                            { label: "24 heures", value: 24 * 60 * 60 * 1000 },
                            { label: "1 semaine", value: 7 * 24 * 60 * 60 * 1000 },
                            { label: "30 jours", value: 30 * 24 * 60 * 60 * 1000 },
                        ].map((opt, i) => (
                            <TouchableOpacity
                                key={i}
                                onPress={() => handleAutoDeleteChange(opt.value)}
                                style={{
                                    paddingVertical: 15,
                                    width: '100%',
                                    borderBottomWidth: i === 4 ? 0 : 1,
                                    borderBottomColor: colors.border,
                                    alignItems: 'center'
                                }}
                            >
                                <Text style={{
                                    fontSize: 16,
                                    color: opt.value === autoDeleteDelay ? colors.primary : colors.text,
                                    fontWeight: opt.value === autoDeleteDelay ? 'bold' : 'normal'
                                }}>{opt.label}</Text>
                            </TouchableOpacity>
                        ))}

                        <TouchableOpacity
                            onPress={() => setShowAutoDeleteModal(false)}
                            style={{ marginTop: 20, padding: 10 }}
                        >
                            <Text style={{ color: colors.primary, fontSize: 16 }}>Annuler</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>
        </View>
    );
}
