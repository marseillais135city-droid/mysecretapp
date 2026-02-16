import nacl from '@/components/CryptoPolyfill';
import { getGhostStyles } from '@/components/GhostTheme';
import { getServerURL } from '@/constants/Config';
import { useTheme } from '@/context/ThemeContext';
import { authFetch, getBoxPublicKeyHex, getBoxSecretKey, getMyID } from '@/utils/AuthHelper';
import { secureGet, secureSet } from '@/utils/SecureStorage';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { encode as encodeBase64 } from 'base-64';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system/legacy';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, Image, KeyboardAvoidingView, Modal, Platform, Text, TextInput, TouchableOpacity, View } from 'react-native';

const CONTACTS_KEY = "my_contacts_list_v1";
const PROFILE_KEY = "my_profile_data_v1";

const stringToUint8Array = (str: string) => { const bytes = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xFF; return bytes; };
const toHex = (buffer: Uint8Array) => Array.prototype.map.call(new Uint8Array(buffer), (x: number) => ('00' + x.toString(16)).slice(-2)).join('');
const uint8ArrayToString = (arr: Uint8Array) => { let str = ''; for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]); return str; };

interface Contact {
    id: string;
    name: string;
    key: string;
    avatar?: string | null;
    isSelf?: boolean;
    alias?: string;
    isBlocked?: boolean;
}

interface FriendRequest {
    from: Contact;
    timestamp: string;
}

// ─── QR Code Validation ─────────────────────────────────────────
function validateQRContact(data: any): boolean {
    if (!data || typeof data !== 'object') return false;
    if (typeof data.id !== 'string' || data.id.length !== 12 || !/^[A-F0-9]+$/i.test(data.id)) return false;
    if (typeof data.key !== 'string' || data.key.length !== 64 || !/^[a-f0-9]+$/i.test(data.key)) return false;
    if (data.name && (typeof data.name !== 'string' || data.name.length > 50)) return false;
    return true;
}

export default function ContactsScreen() {
    const { colors } = useTheme();
    const styles = useMemo(() => getGhostStyles(colors), [colors]);
    const router = useRouter();
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [requests, setRequests] = useState<FriendRequest[]>([]);
    const [isScanning, setIsScanning] = useState(false);
    const [permission, requestPermission] = useCameraPermissions();
    const [notification, setNotification] = useState<{ message: string, type: string } | null>(null);
    const [myID, setMyID] = useState<string | null>(null);
    const [myProfile, setMyProfile] = useState<Contact | null>(null);
    const mySecretKeyRef = useRef<Uint8Array | null>(null);
    const [isAddModalVisible, setIsAddModalVisible] = useState(false);
    const [isIdInputVisible, setIsIdInputVisible] = useState(false);
    const [contactPresence, setContactPresence] = useState<{ [key: string]: { isOnline: boolean, lastSeen: number | null } }>({});
    const [idToAdd, setIdToAdd] = useState("");

    const isProcessingScanRef = useRef(false);

    useFocusEffect(
        useCallback(() => {
            loadIdentity();
            loadContacts();
            loadPresence();
            const contactInterval = setInterval(loadContacts, 3000);
            const presenceInterval = setInterval(loadPresence, 3000);
            return () => {
                clearInterval(contactInterval);
                clearInterval(presenceInterval);
            };
        }, [])
    );

    useFocusEffect(
        useCallback(() => {
            if (!myID) return;
            pollRequests();
            const interval = setInterval(pollRequests, 5000);
            return () => clearInterval(interval);
        }, [myID])
    );

    const loadIdentity = async () => {
        try {
            const secretKey = await getBoxSecretKey();
            const id = await getMyID();
            const profileJson = await secureGet(PROFILE_KEY);
            const profile = profileJson ? JSON.parse(profileJson) : { pseudo: "Unknown" };
            const pkHex = await getBoxPublicKeyHex();

            if (secretKey && id && pkHex) {
                setMyID(id);
                mySecretKeyRef.current = secretKey;
                setMyProfile({
                    id: id,
                    key: pkHex,
                    name: profile.pseudo,
                    avatar: profile.avatar
                });
            }
        } catch (e) {
            console.log("Error loading identity", e);
        }
    };

    const loadPresence = async () => {
        try {
            const json = await AsyncStorage.getItem("contact_presence");
            if (json) {
                setContactPresence(JSON.parse(json));
            }
        } catch (e) { }
    };

    const loadContacts = async () => {
        try {
            const json = await secureGet(CONTACTS_KEY);
            if (json) {
                const list = JSON.parse(json);
                setContacts(list.filter((c: any) => !c.isSelf));
            }
        } catch (e) { }
    };

    const pollRequests = async () => {
        try {
            const serverURL = await getServerURL();
            const res = await authFetch(`${serverURL}/friend-requests/${myID}`, { method: 'GET' });
            if (res.ok) {
                const data = await res.json();
                setRequests(data);
                await secureSet("my_contact_requests_v1", JSON.stringify(data));
            }
        } catch (e) { }
    };

    const showNotification = (message: string, type = 'success') => {
        setNotification({ message, type });
        setTimeout(() => setNotification(null), 3000);
    };

    const handleScannedContact = async (data: string) => {
        if (isProcessingScanRef.current) return;
        isProcessingScanRef.current = true;

        setIsScanning(false);
        try {
            const targetContact = JSON.parse(data);

            // Validate QR code format
            if (!validateQRContact(targetContact)) {
                showNotification("QR Code invalide ou corrompu", "error");
                isProcessingScanRef.current = false;
                return;
            }

            if (targetContact.id === myID) {
                showNotification("Vous ne pouvez pas vous ajouter vous-même", "error");
                isProcessingScanRef.current = false;
                return;
            }

            if (contacts.find(c => c.id === targetContact.id)) {
                showNotification("Déjà dans vos contacts", "warning");
                isProcessingScanRef.current = false;
                return;
            }

            // Only send request — contact will be added when they accept
            await sendFriendRequest(targetContact);
        } catch (e) {
            showNotification("QR Code invalide", "error");
        } finally {
            isProcessingScanRef.current = false;
        }
    };

    const sendFriendRequest = async (target: any) => {
        try {
            // Build identity from auth helpers (don't rely on React state)
            const id = await getMyID();
            const pkHex = await getBoxPublicKeyHex();
            if (!id || !pkHex) {
                showNotification("Identité non chargée", "error");
                return;
            }

            const profileJson = await secureGet(PROFILE_KEY);
            const profile = profileJson ? JSON.parse(profileJson) : { pseudo: "Unknown" };

            const from = {
                id,
                key: pkHex,
                name: profile.pseudo || "Unknown",
                avatar: profile.avatar || null
            };

            const serverURL = await getServerURL();
            const res = await authFetch(`${serverURL}/friend-request`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ to: target.id, from })
            });
            const json = await res.json();
            if (json.status === "ALREADY_SENT") {
                showNotification("Demande déjà envoyée.", "warning");
            } else if (json.status === "OK") {
                showNotification(`Demande envoyée à ${target.name || target.id} !`, "success");
            } else {
                console.error("[FRIEND_REQUEST] Error:", json);
                showNotification("Erreur d'envoi de la demande", "error");
            }
        } catch (e) {
            console.error("[FRIEND_REQUEST] Failed:", e);
            showNotification("Erreur d'envoi de la demande", "error");
        }
    };

    const saveAvatarLocally = async (id: string, base64Data: string) => {
        try {
            // Limit avatar size (max 500KB base64)
            if (base64Data.length > 500000) {
                console.warn("[AVATAR] Avatar too large, skipping save");
                return null;
            }
            const parts = base64Data.split(';base64,');
            const b64 = parts[1] || parts[0];
            if (!b64 || b64.length === 0) return null;
            const filename = `avatar_${id}_${Date.now()}.jpg`;
            const fileUri = (FileSystem.documentDirectory || "") + filename;
            await FileSystem.writeAsStringAsync(fileUri, b64, { encoding: 'base64' });
            return fileUri;
        } catch (err) {
            console.error("[AVATAR] Failed to save local file", err);
            return null;
        }
    };

    const addContactLocally = async (newContact: any, silent = false) => {
        const current = await secureGet(CONTACTS_KEY);
        let list = current ? JSON.parse(current) : [];

        const existing = list.find((c: any) => c.id === newContact.id);
        if (existing) {
            if (existing.key !== newContact.key) {
                console.warn(`[SECURITY] Key mismatch for ${newContact.id}`);
                list = list.map((c: any) => c.id === newContact.id ? { ...c, securityWarning: true, pendingNewKey: newContact.key } : c);
                await secureSet(CONTACTS_KEY, JSON.stringify(list));
                if (!silent) Alert.alert("Alerte Sécurité", `Le numéro de sécurité de ${newContact.name} a changé.`);
            }
            return;
        }

        let finalAvatar = newContact.avatar;
        if (newContact.avatar && newContact.avatar.startsWith('data:')) {
            const local = await saveAvatarLocally(newContact.id, newContact.avatar);
            if (local) finalAvatar = local;
        }

        const contact = {
            id: newContact.id,
            name: newContact.name || `Contact ${newContact.id.substring(0, 4)}`,
            key: newContact.key,
            avatar: finalAvatar || null,
            isSelf: false
        };

        list.push(contact);
        await secureSet(CONTACTS_KEY, JSON.stringify(list));
        setContacts(list);
        if (!silent) showNotification(`${contact.name} ajouté !`, "success");
    };

    const acceptRequest = async (req: FriendRequest) => {
        try {
            console.log(`[ACCEPT] Accepting request from ${req.from.id}...`);
            await sendHandshake(req.from);
            await addContactLocally(req.from, true);
            await removeRequest(req.from.id);
            showNotification(`${req.from.name} accepté !`, "success");
            loadContacts();
            pollRequests();
        } catch (e) {
            console.error("[ACCEPT] Failed to accept request", e);
            showNotification("Erreur lors de l'acceptation", "error");
        }
    };

    const rejectRequest = async (req: FriendRequest) => {
        await removeRequest(req.from.id);
        showNotification("Demande refusée", "secondary");
        pollRequests();
    };

    const removeRequest = async (fromId: string) => {
        try {
            const serverURL = await getServerURL();
            await authFetch(`${serverURL}/friend-request/remove`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: myID, fromId })
            });
        } catch (e) { }
    };

    const deleteContact = async (id: string) => {
        Alert.alert(
            "Supprimer",
            "Voulez-vous supprimer ce contact ?",
            [
                { text: "Annuler", style: "cancel" },
                {
                    text: "Supprimer",
                    style: "destructive",
                    onPress: async () => {
                        const contactToDelete = contacts.find(c => c.id === id);
                        if (contactToDelete) {
                            await sendDeleteSignal(contactToDelete);
                        }

                        const updated = contacts.filter(c => c.id !== id);
                        setContacts(updated);
                        const current = await secureGet(CONTACTS_KEY);
                        let fullList = current ? JSON.parse(current) : [];
                        const newList = fullList.filter((c: any) => c.id !== id);
                        await secureSet(CONTACTS_KEY, JSON.stringify(newList));
                        showNotification("Contact supprimé", "success");
                    }
                }
            ]
        );
    };

    const sendDeleteSignal = async (target: any) => {
        if (!mySecretKeyRef.current) return;
        try {
            const serverURL = await getServerURL();
            // FIX: Use hex decode (not base64) for public key - consistent with rest of codebase
            const targetPub = new Uint8Array(target.key.match(/.{1,2}/g).map((byte: string) => parseInt(byte, 16)));
            const nonce = nacl.randomBytes(nacl.box.nonceLength);
            const signal = "GHOST_SIGNAL:DELETE";
            const encrypted = nacl.box(stringToUint8Array(signal), nonce, targetPub, mySecretKeyRef.current!);
            const fullMessage = new Uint8Array(nonce.length + encrypted.length);
            fullMessage.set(nonce); fullMessage.set(encrypted, nonce.length);

            await authFetch(`${serverURL}/send`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    to: target.id,
                    encryptedContent: encodeBase64(uint8ArrayToString(fullMessage))
                })
            });
            console.log(`[DELETE_SYNC] Signal sent to ${target.id}`);
        } catch (e) {
            console.error("Delete signal failed", e);
        }
    };

    const sendHandshake = async (target: any) => {
        if (!myProfile || !mySecretKeyRef.current) return;
        try {
            const serverURL = await getServerURL();
            const targetPub = new Uint8Array(target.key.match(/.{1,2}/g).map((byte: any) => parseInt(byte, 16)));
            const nonce = nacl.randomBytes(nacl.box.nonceLength);

            const profileJson = await secureGet(PROFILE_KEY);
            const profile = profileJson ? JSON.parse(profileJson) : {};

            // Include id and key so the requester can add us as a contact
            const handshakeData = {
                id: myProfile.id,
                name: profile.pseudo || myProfile.name,
                key: myProfile.key,
                avatar: profile.avatar || myProfile.avatar || null
            };

            const signal = "GHOST_SIGNAL:ACCEPT:" + JSON.stringify(handshakeData);
            const encrypted = nacl.box(stringToUint8Array(signal), nonce, targetPub, mySecretKeyRef.current!);

            const myPubKey = nacl.box.keyPair.fromSecretKey(mySecretKeyRef.current!).publicKey;
            const fullMessage = new Uint8Array(myPubKey.length + nonce.length + encrypted.length);
            fullMessage.set(myPubKey);
            fullMessage.set(nonce, myPubKey.length);
            fullMessage.set(encrypted, myPubKey.length + nonce.length);

            await authFetch(`${serverURL}/send`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    to: target.id,
                    encryptedContent: encodeBase64(uint8ArrayToString(fullMessage))
                })
            });
            console.log(`[HANDSHAKE] Sent anonymous handshake to ${target.id}`);
        } catch (e) {
            console.error("Handshake failed", e);
        }
    };

    const openChat = (contact: Contact) => {
        router.push({
            pathname: "/chat",
            params: {
                contactId: contact.id,
                contactName: contact.name,
                contactKey: contact.key,
                contactAvatar: contact.avatar ?? undefined
            }
        });
    };

    const handleAddById = async () => {
        if (!idToAdd.trim()) return;
        setIsIdInputVisible(false);
        const targetId = idToAdd.trim().toUpperCase();

        if (contacts.find(c => c.id === targetId)) {
            showNotification("Déjà dans vos contacts", "warning");
            return;
        }

        await sendFriendRequest({ id: targetId, name: `Contact ${targetId.substring(0, 4)}` });
        setIdToAdd("");
    };

    if (isScanning) {
        if (!permission) {
            return <View />;
        }
        if (!permission.granted) {
            return (
                <View style={styles.container}>
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <Text style={{ fontSize: 18, marginBottom: 20, textAlign: 'center', color: colors.text }}>
                            Nous avons besoin de la caméra pour scanner le QR Code.
                        </Text>
                        <TouchableOpacity
                            onPress={requestPermission}
                            style={{ backgroundColor: colors.primary, padding: 10, borderRadius: 10 }}
                        >
                            <Text style={{ color: 'white', fontWeight: 'bold' }}>Autoriser la caméra</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            onPress={() => setIsScanning(false)}
                            style={{ marginTop: 20 }}
                        >
                            <Text style={{ color: colors.text, fontSize: 16 }}>Annuler</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            );
        }

        return (
            <CameraView
                style={{ flex: 1 }}
                onBarcodeScanned={({ data }) => handleScannedContact(data)}
            >
                <TouchableOpacity
                    style={{ position: 'absolute', top: 50, right: 20, padding: 10, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 20 }}
                    onPress={() => setIsScanning(false)}
                >
                    <Text style={{ color: 'white', fontSize: 18, fontWeight: 'bold' }}>Fermer</Text>
                </TouchableOpacity>
            </CameraView>
        );
    }

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.headerTitle}>Contacts</Text>
                <TouchableOpacity
                    style={{
                        backgroundColor: colors.primary,
                        flexDirection: 'row', alignItems: 'center',
                        paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20
                    }}
                    onPress={() => setIsAddModalVisible(true)}
                >
                    <Text style={{ fontSize: 18, color: 'white', marginRight: 5 }}>+</Text>
                    <Text style={{ fontSize: 14, color: 'white', fontWeight: 'bold' }}>Ajouter</Text>
                </TouchableOpacity>
            </View>

            {requests.length > 0 && (
                <View style={{ padding: 15, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border }}>
                    <Text style={{ fontWeight: 'bold', marginBottom: 10, color: colors.text }}>Demandes d'amis ({requests.length})</Text>
                    {requests.map((req, idx) => (
                        <View key={idx} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10, backgroundColor: colors.background, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.border }}>
                            <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.border, marginRight: 10, overflow: 'hidden' }}>
                                {req.from.avatar ? <Image source={{ uri: req.from.avatar }} style={{ width: '100%', height: '100%' }} /> : <Text style={{ textAlign: 'center', lineHeight: 40, color: colors.textSecondary }}>👤</Text>}
                            </View>
                            <View style={{ flex: 1 }}>
                                <Text style={{ fontWeight: 'bold', color: colors.text }}>{req.from.name}</Text>
                                <Text style={{ fontSize: 12, color: colors.textSecondary }}>veut vous ajouter</Text>
                            </View>
                            <TouchableOpacity onPress={() => acceptRequest(req)} style={{ backgroundColor: colors.primary, padding: 8, borderRadius: 8, marginRight: 5 }}>
                                <Text style={{ color: 'white', fontSize: 12 }}>Accepter</Text>
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => rejectRequest(req)} style={{ backgroundColor: colors.textSecondary, padding: 8, borderRadius: 8 }}>
                                <Text style={{ color: 'white', fontSize: 12 }}>Refuser</Text>
                            </TouchableOpacity>
                        </View>
                    ))}
                </View>
            )}

            <FlatList
                data={contacts}
                keyExtractor={item => item.id}
                renderItem={({ item }) => (
                    <TouchableOpacity
                        style={styles.card}
                        onPress={() => openChat(item)}
                        onLongPress={() => deleteContact(item.id)}
                    >
                        <View style={styles.avatarContainer}>
                            {item.avatar ? (
                                <Image source={{ uri: item.avatar }} style={styles.avatarImage} />
                            ) : (
                                <Text style={{ fontSize: 24, color: colors.textSecondary }}>👤</Text>
                            )}
                        </View>
                        <View style={{ flex: 1, justifyContent: 'center' }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <Text style={styles.contactName}>{item.alias || item.name}</Text>
                                {contactPresence[item.id]?.isOnline && (
                                    <View style={{
                                        width: 10, height: 10, borderRadius: 5,
                                        backgroundColor: '#4CAF50', marginLeft: 6,
                                        borderWidth: 1, borderColor: colors.surface
                                    }} />
                                )}
                            </View>
                            {contactPresence[item.id]?.isOnline ? (
                                <Text style={{ fontSize: 12, color: colors.textSecondary }}>En ligne</Text>
                            ) : contactPresence[item.id]?.lastSeen ? (
                                <Text style={{ fontSize: 12, color: colors.textSecondary }}>Vu à {new Date(contactPresence[item.id].lastSeen!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
                            ) : null}
                        </View>
                    </TouchableOpacity>
                )}
                ListEmptyComponent={
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', marginTop: 100 }}>
                        <Text style={{ color: colors.textSecondary, textAlign: 'center' }}>
                            Votre carnet d'adresses est vide.
                        </Text>
                    </View>
                }
            />
            {notification && (
                <View style={{
                    position: 'absolute', top: 120, alignSelf: 'center',
                    backgroundColor: notification.type === 'error' ? colors.error : colors.secondary,
                    paddingVertical: 10, paddingHorizontal: 20, borderRadius: 25,
                    shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 5, elevation: 5, zIndex: 100
                }}>
                    <Text style={{ color: 'white', fontWeight: 'bold' }}>{notification.message}</Text>
                </View>
            )}

            <Modal visible={isAddModalVisible} transparent animationType="fade">
                <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' }}>
                    <View style={{ backgroundColor: colors.surface, width: '80%', padding: 25, borderRadius: 20 }}>
                        <Text style={{ fontSize: 20, fontWeight: 'bold', marginBottom: 20, textAlign: 'center', color: colors.text }}>Nouveau contact</Text>
                        <TouchableOpacity
                            style={{ backgroundColor: colors.primary, padding: 15, borderRadius: 12, marginBottom: 15, flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}
                            onPress={() => { setIsAddModalVisible(false); setIsScanning(true); }}
                        >
                            <Text style={{ fontSize: 20, marginRight: 10 }}>📷</Text>
                            <Text style={{ color: 'white', fontWeight: 'bold' }}>Scanner un QR Code</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={{ backgroundColor: colors.background, padding: 15, borderRadius: 12, marginBottom: 20, flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}
                            onPress={() => { setIsAddModalVisible(false); setIsIdInputVisible(true); }}
                        >
                            <Text style={{ fontSize: 20, marginRight: 10 }}>⌨️</Text>
                            <Text style={{ color: colors.text, fontWeight: 'bold' }}>Saisir un identifiant</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => setIsAddModalVisible(false)}>
                            <Text style={{ textAlign: 'center', color: colors.textSecondary }}>Annuler</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>

            <Modal visible={isIdInputVisible} transparent animationType="slide">
                <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
                    <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
                        <View style={{ backgroundColor: colors.surface, borderTopLeftRadius: 30, borderTopRightRadius: 30, padding: 25, minHeight: 300 }}>
                            <Text style={{ fontSize: 20, fontWeight: 'bold', marginBottom: 20, textAlign: 'center', color: colors.text }}>Ajouter par ID</Text>
                            <Text style={styles.label}>IDENTIFIANT DU CONTACT (12 CAR.)</Text>
                            <TextInput
                                style={[styles.input, { textAlign: 'center', fontSize: 20, letterSpacing: 2, borderBottomWidth: 1, borderBottomColor: colors.border }]}
                                placeholder="A1B2C3D4..."
                                placeholderTextColor={colors.textSecondary}
                                autoCapitalize="characters"
                                maxLength={12}
                                value={idToAdd}
                                onChangeText={setIdToAdd}
                                autoFocus
                            />
                            <TouchableOpacity
                                style={{ backgroundColor: colors.primary, padding: 15, borderRadius: 12, marginTop: 10 }}
                                onPress={handleAddById}
                            >
                                <Text style={{ color: 'white', fontWeight: 'bold', textAlign: 'center' }}>Envoyer la demande</Text>
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => setIsIdInputVisible(false)} style={{ marginTop: 20 }}>
                                <Text style={{ textAlign: 'center', color: colors.textSecondary }}>Fermer</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </KeyboardAvoidingView>
            </Modal>
        </View>
    );
}
