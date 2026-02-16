import { getGhostStyles } from '@/components/GhostTheme';
import { useTheme } from '@/context/ThemeContext';
import { getBoxPublicKeyHex } from '@/utils/AuthHelper';
import { secureGet, secureSet } from '@/utils/SecureStorage';
import * as ExpoCrypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Image, Modal, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';

const CONTACTS_KEY = "my_contacts_list_v1";

export default function ContactDetailsScreen() {
    const { colors } = useTheme();
    const styles = useMemo(() => getGhostStyles(colors), [colors]);
    const router = useRouter();
    const { contactId } = useLocalSearchParams();
    const [contact, setContact] = useState<any>(null);
    const [isEditingAlias, setIsEditingAlias] = useState(false);
    const [alias, setAlias] = useState("");
    const [isDeleted, setIsDeleted] = useState(false);
    const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
    const [isVerified, setIsVerified] = useState(false);
    const [pendingSafetyNumber, setPendingSafetyNumber] = useState<string | null>(null);
    const [ephemeralTimer, setEphemeralTimer] = useState<number | null>(null);
    const [showEphemeralModal, setShowEphemeralModal] = useState(false);

    useEffect(() => {
        loadContact();
    }, [contactId]);

    const loadContact = async () => {
        try {
            const json = await secureGet(CONTACTS_KEY);
            if (json) {
                const list = JSON.parse(json);
                const found = list.find((c: any) => c.id === contactId);
                if (found) {
                    setContact(found);
                    setAlias(found.alias || "");
                    setIsVerified(found.isVerified || false);

                    // Load ephemeral timer for this conversation
                    const timerStr = await SecureStore.getItemAsync(`ephemeral_timer_${contactId}`);
                    setEphemeralTimer(timerStr ? parseInt(timerStr) : null);

                    // Calculate Safety Number using AuthHelper
                    const myPkHex = await getBoxPublicKeyHex();
                    if (myPkHex) {
                        const sn = await generateSafetyNumber(myPkHex, found.key);
                        setSafetyNumber(sn);

                        if (found.pendingNewKey) {
                            const psn = await generateSafetyNumber(myPkHex, found.pendingNewKey);
                            setPendingSafetyNumber(psn);
                        } else {
                            setPendingSafetyNumber(null);
                        }
                    }
                }
            }
        } catch (e) {
            console.error("Failed to load contact details", e);
        }
    };

    const generateSafetyNumber = async (key1: string, key2: string) => {
        const sorted = [key1, key2].sort().join("");
        const hash = await ExpoCrypto.digestStringAsync(ExpoCrypto.CryptoDigestAlgorithm.SHA256, sorted);
        // Create 12 digits: 3 groups of 4
        const n1 = parseInt(hash.substring(0, 4), 16).toString().padStart(4, '0').slice(-4);
        const n2 = parseInt(hash.substring(4, 8), 16).toString().padStart(4, '0').slice(-4);
        const n3 = parseInt(hash.substring(8, 12), 16).toString().padStart(4, '0').slice(-4);
        const n4 = parseInt(hash.substring(12, 16), 16).toString().padStart(4, '0').slice(-4);
        return `${n1} ${n2} ${n3} ${n4}`;
    };

    const toggleVerified = async () => {
        try {
            const json = await secureGet(CONTACTS_KEY);
            if (json) {
                let list = JSON.parse(json);
                list = list.map((c: any) => c.id === contactId ? { ...c, isVerified: !isVerified } : c);
                await secureSet(CONTACTS_KEY, JSON.stringify(list));
                setIsVerified(!isVerified);
            }
        } catch (e) { }
    };

    const approveNewKey = async () => {
        Alert.alert(
            "Approuver la nouvelle clé",
            "Êtes-vous sûr de vouloir accepter ce changement ? Si vous avez un doute, vérifiez le numéro de sécurité de vive voix avec votre contact.",
            [
                { text: "Annuler", style: "cancel" },
                {
                    text: "Approuver",
                    style: "default",
                    onPress: async () => {
                        try {
                            const json = await secureGet(CONTACTS_KEY);
                            if (json) {
                                let list = JSON.parse(json);
                                list = list.map((c: any) => {
                                    if (c.id === contactId) {
                                        return { ...c, key: c.pendingNewKey, securityWarning: false, pendingNewKey: undefined, isVerified: false };
                                    }
                                    return c;
                                });
                                await secureSet(CONTACTS_KEY, JSON.stringify(list));
                                loadContact();
                                Alert.alert("Clé mise à jour", "La nouvelle clé a été acceptée.");
                            }
                        } catch (e) { }
                    }
                }
            ]
        );
    };

    const saveAlias = async () => {
        try {
            const json = await secureGet(CONTACTS_KEY);
            if (json) {
                let list = JSON.parse(json);
                list = list.map((c: any) => {
                    if (c.id === contactId) {
                        return { ...c, alias: alias.trim() || undefined };
                    }
                    return c;
                });
                await secureSet(CONTACTS_KEY, JSON.stringify(list));

                await loadContact();

                setIsEditingAlias(false);
                Alert.alert("Succès", "Nom mis à jour !");
            }
        } catch (e) {
            console.error("Failed to save alias", e);
            Alert.alert("Erreur", "Impossible de sauvegarder l'alias.");
        }
    };

    const handleEphemeralTimerChange = async (value: number | null) => {
        try {
            const key = `ephemeral_timer_${contactId}`;
            if (value === null) {
                await SecureStore.deleteItemAsync(key);
            } else {
                await SecureStore.setItemAsync(key, value.toString());
            }
            setEphemeralTimer(value);
            setShowEphemeralModal(false);
        } catch (e) {
            console.error("Failed to save ephemeral timer", e);
        }
    };

    const getEphemeralLabel = (value: number | null) => {
        if (!value) return "Désactivé";
        if (value === 30) return "30 secondes";
        if (value === 60) return "1 minute";
        if (value === 300) return "5 minutes";
        if (value === 3600) return "1 heure";
        if (value === 86400) return "24 heures";
        if (value === 604800) return "1 semaine";
        return `${value}s`;
    };

    const toggleBlock = async () => {
        try {
            const json = await secureGet(CONTACTS_KEY);
            if (json) {
                let list = JSON.parse(json);
                list = list.map((c: any) => {
                    if (c.id === contactId) {
                        return { ...c, isBlocked: !c.isBlocked };
                    }
                    return c;
                });
                await secureSet(CONTACTS_KEY, JSON.stringify(list));
                setContact({ ...contact, isBlocked: !contact.isBlocked });
                Alert.alert("Contact", contact.isBlocked ? "Contact débloqué" : "Contact bloqué");
            }
        } catch (e) {
            Alert.alert("Erreur", "Action impossible.");
        }
    };

    const deleteContact = () => {
        Alert.alert(
            "Supprimer",
            "Voulez-vous vraiment supprimer ce contact ? Tous vos échanges avec lui seront conservés mais il disparaîtra de votre liste.",
            [
                { text: "Annuler", style: "cancel" },
                {
                    text: "Supprimer",
                    style: "destructive",
                    onPress: async () => {
                        try {
                            const json = await secureGet(CONTACTS_KEY);
                            if (json) {
                                let list = JSON.parse(json);
                                list = list.filter((c: any) => c.id !== contactId);
                                await secureSet(CONTACTS_KEY, JSON.stringify(list));
                                router.replace('/(tabs)/contacts');
                            }
                        } catch (e) {
                            Alert.alert("Erreur", "Suppression impossible.");
                        }
                    }
                }
            ]
        );
    };

    if (!contact) return <View style={styles.container} />;

    if (isDeleted) {
        return (
            <View style={styles.container}>
                <View style={styles.header}>
                    <TouchableOpacity onPress={() => router.back()} style={{ paddingRight: 10 }}>
                        <Text style={{ color: colors.primary, fontSize: 17, fontWeight: '600' }}>Retour</Text>
                    </TouchableOpacity>
                    <Text style={styles.headerTitle}>Infos Contact</Text>
                    <View style={{ width: 50 }} />
                </View>
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 }}>
                    <View style={{ width: 100, height: 100, borderRadius: 50, backgroundColor: colors.border, alignItems: 'center', justifyContent: 'center', marginBottom: 20, opacity: 0.5 }}>
                        <Text style={{ fontSize: 40, color: colors.textSecondary }}>👻</Text>
                    </View>
                    <Text style={{ fontSize: 22, fontWeight: 'bold', color: 'red', marginBottom: 10 }}>Utilisateur Inexistant</Text>
                    <Text style={{ fontSize: 16, color: colors.textSecondary, textAlign: 'center', marginBottom: 30 }}>
                        Ce compte a été supprimé. Vous ne pouvez plus interagir avec cet utilisateur.
                    </Text>
                    <TouchableOpacity
                        style={{ width: '100%', padding: 15, borderRadius: 12, backgroundColor: '#FF3B30', alignItems: 'center' }}
                        onPress={deleteContact}
                    >
                        <Text style={{ color: 'white', fontWeight: 'bold' }}>SUPPRIMER DE MES CONTACTS</Text>
                    </TouchableOpacity>
                </View>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            {/* HEADER */}
            <View style={styles.header}>
                <TouchableOpacity onPress={() => router.back()} style={{ paddingRight: 10 }}>
                    <Text style={{ color: colors.primary, fontSize: 17, fontWeight: '600' }}>Retour</Text>
                </TouchableOpacity>
                <Text style={styles.headerTitle}>Infos Contact</Text>
                <View style={{ width: 50 }} />
            </View>

            <ScrollView contentContainerStyle={{ alignItems: 'center', padding: 20 }}>
                <View style={{ width: 120, height: 120, borderRadius: 60, overflow: 'hidden', backgroundColor: colors.border, marginBottom: 20 }}>
                    {contact.avatar ? (
                        <Image source={{ uri: contact.avatar }} style={{ width: '100%', height: '100%' }} />
                    ) : (
                        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 40, color: colors.textSecondary }}>👤</Text></View>
                    )}
                </View>

                <Text style={{ fontSize: 18, color: colors.textSecondary, marginBottom: 5 }}>Public ID</Text>
                <Text style={{ fontSize: 16, fontWeight: 'bold', color: colors.text, marginBottom: 30 }}>{contact.id}</Text>

                <View style={{ width: '100%', backgroundColor: colors.surface, padding: 20, borderRadius: 20, marginBottom: 20 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                        <Text style={styles.label}>NOM D'AFFICHAGE</Text>
                        <TouchableOpacity onPress={() => isEditingAlias ? saveAlias() : setIsEditingAlias(true)}>
                            <Text style={{ color: colors.primary, fontWeight: 'bold' }}>{isEditingAlias ? "OK" : "Modifier"}</Text>
                        </TouchableOpacity>
                    </View>

                    {isEditingAlias ? (
                        <TextInput
                            style={[styles.input, { backgroundColor: colors.background, paddingVertical: 10 }]}
                            value={alias}
                            onChangeText={setAlias}
                            placeholder={contact.name}
                            autoFocus
                        />
                    ) : (
                        <Text style={{ fontSize: 20, fontWeight: 'bold', color: colors.text }}>
                            {contact.alias || contact.name}
                            {contact.alias && <Text style={{ fontSize: 14, fontWeight: 'normal', color: colors.textSecondary }}> ({contact.name})</Text>}
                        </Text>
                    )}
                </View>

                {/* SAFETY SECTION */}
                <View style={{ width: '100%', backgroundColor: colors.surface, padding: 20, borderRadius: 20, marginBottom: 20 }}>
                    <Text style={styles.label}>SÉCURITÉ ET CHIFFREMENT</Text>

                    {contact.securityWarning ? (
                        <View style={{ backgroundColor: 'rgba(255, 59, 48, 0.1)', padding: 15, borderRadius: 12, marginTop: 10, borderWidth: 1, borderColor: '#FF3B30' }}>
                            <Text style={{ color: '#FF3B30', fontWeight: 'bold', marginBottom: 5 }}>⚠️ ALERTE : La clé a changé !</Text>
                            <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 10 }}>
                                Le numéro de sécurité ne correspond plus. Cela peut être une tentative d'interception ou une réinstallation de l'app par votre contact.
                            </Text>
                            <TouchableOpacity
                                style={{ backgroundColor: colors.primary, padding: 10, borderRadius: 8, alignItems: 'center' }}
                                onPress={approveNewKey}
                            >
                                <Text style={{ color: 'white', fontWeight: 'bold' }}>APPROUVER LA NOUVELLE CLÉ</Text>
                            </TouchableOpacity>
                        </View>
                    ) : (
                        <View style={{ marginTop: 10 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 15 }}>
                                <View style={{ flex: 1 }}>
                                    <Text style={{ fontSize: 12, color: colors.textSecondary }}>NUMÉRO DE SÉCURITÉ ACTUEL</Text>
                                    <Text style={{ fontSize: 22, fontWeight: 'bold', color: colors.text, letterSpacing: 2 }}>{safetyNumber || "Chargement..."}</Text>
                                </View>
                            </View>

                            {pendingSafetyNumber && (
                                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 15, padding: 10, backgroundColor: 'rgba(255, 149, 0, 0.1)', borderRadius: 10, borderWidth: 1, borderColor: '#FF9500' }}>
                                    <View style={{ flex: 1 }}>
                                        <Text style={{ fontSize: 12, color: '#FF9500', fontWeight: 'bold' }}>NOUVEAU NUMÉRO DÉTECTÉ</Text>
                                        <Text style={{ fontSize: 22, fontWeight: 'bold', color: colors.text, letterSpacing: 2 }}>{pendingSafetyNumber}</Text>
                                        <Text style={{ fontSize: 11, color: colors.textSecondary, marginTop: 5 }}>
                                            Comparez ce numéro avec votre contact. S'il correspond au sien, vous pouvez approuver la nouvelle clé.
                                        </Text>
                                    </View>
                                </View>
                            )}

                            {!pendingSafetyNumber && isVerified && (
                                <View style={{ position: 'absolute', top: 0, right: 0 }}>
                                    <Text style={{ fontSize: 24 }}>✅</Text>
                                </View>
                            )}

                            <Text style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 15 }}>
                                Pour vérifier le chiffrement de bout en bout, comparez ce numéro avec votre contact sur un autre canal (appel, de vive voix).
                            </Text>

                            <TouchableOpacity
                                style={{ flexDirection: 'row', alignItems: 'center', padding: 10, backgroundColor: isVerified ? 'rgba(76, 175, 80, 0.1)' : colors.background, borderRadius: 10, borderWidth: 1, borderColor: isVerified ? '#4CAF50' : colors.border }}
                                onPress={toggleVerified}
                            >
                                <Text style={{ fontSize: 18, marginRight: 10 }}>{isVerified ? "🔒" : "🔓"}</Text>
                                <Text style={{ color: isVerified ? '#4CAF50' : colors.text, fontWeight: 'bold' }}>
                                    {isVerified ? "VÉRIFIÉ ET SÉCURISÉ" : "MARQUER COMME VÉRIFIÉ"}
                                </Text>
                            </TouchableOpacity>
                        </View>
                    )}
                </View>

                {/* MESSAGES ÉPHÉMÈRES */}
                <View style={{ width: '100%', backgroundColor: colors.surface, padding: 20, borderRadius: 20, marginBottom: 20, borderWidth: 1, borderColor: colors.border }}>
                    <Text style={styles.label}>MESSAGES ÉPHÉMÈRES</Text>
                    <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 5, marginBottom: 15 }}>
                        Les messages seront automatiquement supprimés après la durée choisie.
                    </Text>
                    <TouchableOpacity
                        style={{
                            flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                            padding: 12, backgroundColor: colors.background, borderRadius: 10, borderWidth: 1, borderColor: colors.border
                        }}
                        onPress={() => setShowEphemeralModal(true)}
                    >
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            <Text style={{ fontSize: 20, marginRight: 10 }}>{ephemeralTimer ? '⏱️' : '💬'}</Text>
                            <Text style={{ fontSize: 16, color: colors.text, fontWeight: '600' }}>
                                {ephemeralTimer ? getEphemeralLabel(ephemeralTimer) : "Désactivé"}
                            </Text>
                        </View>
                        <Text style={{ color: colors.primary, fontWeight: 'bold' }}>Modifier ›</Text>
                    </TouchableOpacity>
                </View>

                <TouchableOpacity
                    style={{ width: '100%', padding: 15, borderRadius: 12, backgroundColor: colors.surface, alignItems: 'center', marginBottom: 15, borderWidth: 1, borderColor: colors.border }}
                    onPress={toggleBlock}
                >
                    <Text style={{ color: contact.isBlocked ? colors.primary : '#FF9500', fontWeight: 'bold' }}>
                        {contact.isBlocked ? "DÉBLOQUER CE CONTACT" : "BLOQUER CE CONTACT"}
                    </Text>
                </TouchableOpacity>

                <TouchableOpacity
                    style={{ width: '100%', padding: 15, borderRadius: 12, backgroundColor: '#FF3B30', alignItems: 'center' }}
                    onPress={deleteContact}
                >
                    <Text style={{ color: 'white', fontWeight: 'bold' }}>SUPPRIMER DE MES CONTACTS</Text>
                </TouchableOpacity>
            </ScrollView>

            {/* EPHEMERAL TIMER MODAL */}
            <Modal visible={showEphemeralModal} transparent animationType="fade" onRequestClose={() => setShowEphemeralModal(false)}>
                <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' }}>
                    <View style={{ width: '80%', backgroundColor: colors.surface, borderRadius: 20, padding: 20, alignItems: 'center' }}>
                        <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.text, marginBottom: 10 }}>Messages éphémères</Text>
                        <Text style={{ color: colors.textSecondary, textAlign: 'center', marginBottom: 20, fontSize: 13 }}>
                            Les messages de cette conversation seront supprimés automatiquement après la durée choisie.
                        </Text>

                        {[
                            { label: "Désactivé", value: null },
                            { label: "30 secondes", value: 30 },
                            { label: "1 minute", value: 60 },
                            { label: "5 minutes", value: 300 },
                            { label: "1 heure", value: 3600 },
                            { label: "24 heures", value: 86400 },
                            { label: "1 semaine", value: 604800 },
                        ].map((opt, i) => (
                            <TouchableOpacity
                                key={i}
                                onPress={() => handleEphemeralTimerChange(opt.value)}
                                style={{
                                    paddingVertical: 14, width: '100%',
                                    borderBottomWidth: i === 6 ? 0 : 1, borderBottomColor: colors.border,
                                    alignItems: 'center', flexDirection: 'row', justifyContent: 'center'
                                }}
                            >
                                <Text style={{
                                    fontSize: 16,
                                    color: opt.value === ephemeralTimer ? colors.primary : colors.text,
                                    fontWeight: opt.value === ephemeralTimer ? 'bold' : 'normal'
                                }}>
                                    {opt.value === ephemeralTimer ? '✓ ' : ''}{opt.label}
                                </Text>
                            </TouchableOpacity>
                        ))}

                        <TouchableOpacity onPress={() => setShowEphemeralModal(false)} style={{ marginTop: 20, padding: 10 }}>
                            <Text style={{ color: colors.primary, fontSize: 16 }}>Annuler</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>
        </View>
    );
}
