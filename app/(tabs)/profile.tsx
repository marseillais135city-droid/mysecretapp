import nacl from '@/components/CryptoPolyfill';
import { getGhostStyles } from '@/components/GhostTheme';
import { AVATARS } from '@/constants/Avatars';
import { getServerURL } from '@/constants/Config';
import { useTheme } from '@/context/ThemeContext';
import { authFetch } from '@/utils/AuthHelper';
import { secureGet, secureSet } from '@/utils/SecureStorage';
import { decode as decodeBase64, encode as encodeBase64 } from 'base-64';
import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import React, { useMemo, useState } from 'react';
import { Alert, Image, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

const PROFILE_KEY = "my_profile_data_v1";
const STORAGE_KEY = "my_permanent_secret_key_v1";
const CONTACTS_KEY = "my_contacts_list_v1";

const uint8ArrayToString = (arr: Uint8Array) => { let str = ''; for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]); return str; };
const stringToUint8Array = (str: string) => { const bytes = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i); return bytes; };
const toHex = (buffer: ArrayBuffer | Uint8Array) => Array.prototype.map.call(new Uint8Array(buffer), x => ('00' + x.toString(16)).slice(-2)).join('');


export default function ProfileScreen() {
    const { colors, isDark } = useTheme();
    const styles = useMemo(() => getGhostStyles(colors), [colors]);
    const router = useRouter();
    const [pseudo, setPseudo] = useState("Chargement...");
    const [avatar, setAvatar] = useState<string | null>(null);
    const [qrValue, setQrValue] = useState<string | null>(null);
    const [myID, setMyID] = useState("");
    const [showQR, setShowQR] = useState(false);
    const [showID, setShowID] = useState(false);

    // Editing State
    const [isEditing, setIsEditing] = useState(false);
    const [editPseudo, setEditPseudo] = useState("");
    const [editAvatar, setEditAvatar] = useState("");

    React.useEffect(() => {
        loadProfile();
    }, []);

    const loadProfile = async () => {
        try {
            const json = await secureGet(PROFILE_KEY);
            if (json) {
                const p = JSON.parse(json);
                setPseudo(p.pseudo);
                setAvatar(p.avatar);
                setEditPseudo(p.pseudo);
                setEditAvatar(p.avatar);
            }

            const stored = await SecureStore.getItemAsync(STORAGE_KEY);
            if (stored) {
                const secretKey = new Uint8Array(stringToUint8Array(decodeBase64(stored)));
                const keyPair = nacl.box.keyPair.fromSecretKey(secretKey);
                const pkHex = toHex(keyPair.publicKey);
                const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, pkHex);
                const id = hash.substring(0, 12).toUpperCase();
                setMyID(id);

                updateQR(id, pkHex, json);
            }
        } catch (e) {
            console.error("Profile: Error loading profile", e);
        }
    };

    const updateQR = (id: string, pkHex: string, jsonStr: string | null) => {
        const p = JSON.parse(jsonStr || "{}");
        // Don't include Base64 avatar in QR code as it's too big
        const isBase64 = p.avatar && p.avatar.startsWith('data:');

        const data = JSON.stringify({
            id: id,
            key: pkHex,
            name: p.pseudo || "Unknown",
            avatar: isBase64 ? null : p.avatar
        });
        setQrValue(data);
    };

    const saveProfileChanges = async () => {
        if (!editPseudo.trim()) return;

        const updatedProfile = {
            pseudo: editPseudo.trim(),
            avatar: editAvatar
        };

        try {
            await secureSet(PROFILE_KEY, JSON.stringify(updatedProfile));
            setPseudo(updatedProfile.pseudo);
            setAvatar(updatedProfile.avatar);
            setIsEditing(false);

            // Update QR code with new info
            const stored = await SecureStore.getItemAsync(STORAGE_KEY);
            if (stored) {
                const secretKey = new Uint8Array(stringToUint8Array(decodeBase64(stored)));
                const keyPair = nacl.box.keyPair.fromSecretKey(secretKey);
                const pkHex = toHex(keyPair.publicKey);
                updateQR(myID, pkHex, JSON.stringify(updatedProfile));

                // BROADCAST TO CONTACTS
                broadcastProfileUpdate(updatedProfile, secretKey);
            }
            Alert.alert("Succès", "Profil mis à jour !");
        } catch (e) {
            console.error("Failed to save profile", e);
            Alert.alert("Erreur", "Impossible de sauvegarder les changements.");
        }
    };

    const broadcastProfileUpdate = async (profileData: any, mySecretKey: Uint8Array) => {
        try {
            const contactsJson = await secureGet(CONTACTS_KEY);
            if (!contactsJson) return;
            const contacts = JSON.parse(contactsJson);
            const serverURL = await getServerURL();

            const signal = `GHOST_SIGNAL:PROFILE_UPDATE:${JSON.stringify(profileData)}`;

            for (const contact of contacts) {
                if (contact.isSelf) continue;
                try {
                    const nonce = nacl.randomBytes(nacl.box.nonceLength);
                    const msgBytes = stringToUint8Array(signal);
                    const peerPublicKeyBytes = new Uint8Array(contact.key.match(/.{1,2}/g).map((byte: string) => parseInt(byte, 16)));
                    const encrypted = nacl.box(msgBytes, nonce, peerPublicKeyBytes, mySecretKey);

                    const fullMessage = new Uint8Array(nonce.length + encrypted.length);
                    fullMessage.set(nonce);
                    fullMessage.set(encrypted, nonce.length);

                    const base64Content = encodeBase64(uint8ArrayToString(fullMessage));

                    await authFetch(`${serverURL}/send`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            to: contact.id,
                            encryptedContent: base64Content
                        })
                    });
                    console.log(`[PROFILE_SYNC] Signal sent to ${contact.id}`);
                } catch (err) {
                    console.error(`[PROFILE_SYNC] Failed to send signal to ${contact.id}`, err);
                }
            }
        } catch (e) {
            console.error("Broadcast failed", e);
        }
    };



    const pickImage = async () => {
        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.5, // Reduce quality for sharing
        });

        if (!result.canceled) {
            const asset = result.assets[0];
            try {
                const b64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: 'base64' });
                setEditAvatar(`data:image/jpeg;base64,${b64}`);
            } catch (err) {
                console.error("Failed to read image", err);
                Alert.alert("Erreur", "Impossible de lire l'image sélectionnée.");
            }
        }
    };

    const copyToClipboard = async () => {
        await Clipboard.setStringAsync(myID);
        Alert.alert("Copié !", "L'ID a été copié dans le presse-papier.");
    };


    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.headerTitle}>Mon Profil</Text>
                <TouchableOpacity onPress={() => isEditing ? saveProfileChanges() : setIsEditing(true)}>
                    <Text style={{ color: colors.primary, fontWeight: 'bold' }}>
                        {isEditing ? "Enregistrer" : "Modifier"}
                    </Text>
                </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={{ alignItems: 'center', padding: 20 }}>

                <View style={{
                    width: 120, height: 120, borderRadius: 60, marginBottom: 20,
                    backgroundColor: colors.border, justifyContent: 'center', alignItems: 'center', overflow: 'hidden',
                    borderWidth: isEditing ? 3 : 0, borderColor: colors.primary
                }}>
                    {isEditing ? (
                        <Image source={{ uri: editAvatar }} style={{ width: '100%', height: '100%' }} />
                    ) : (
                        avatar ? (
                            <Image source={{ uri: avatar }} style={{ width: '100%', height: '100%' }} />
                        ) : (
                            <Text style={{ fontSize: 40, color: colors.textSecondary }}>👤</Text>
                        )
                    )}
                </View>

                {isEditing ? (
                    <View style={{ width: '100%', alignItems: 'center', marginBottom: 20 }}>
                        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 70, marginBottom: 20 }}>
                            {AVATARS.map((uri, index) => (
                                <TouchableOpacity key={index} onPress={() => setEditAvatar(uri)} style={{ marginHorizontal: 8 }}>
                                    <Image source={{ uri }} style={{ width: 50, height: 50, borderRadius: 25, borderWidth: editAvatar === uri ? 3 : 0, borderColor: colors.primary }} />
                                </TouchableOpacity>
                            ))}
                        </ScrollView>

                        <TouchableOpacity
                            onPress={pickImage}
                            style={{
                                backgroundColor: colors.surface,
                                paddingHorizontal: 20,
                                paddingVertical: 10,
                                borderRadius: 20,
                                marginBottom: 20,
                                borderWidth: 1,
                                borderColor: colors.primary + '40'
                            }}
                        >
                            <Text style={{ color: colors.primary, fontWeight: 'bold' }}>📸 Choisir depuis la galerie</Text>
                        </TouchableOpacity>

                        <View style={{ width: '100%', marginBottom: 10 }}>
                            <Text style={styles.label}>PSEUDO</Text>
                            <TextInput
                                style={[styles.input, { backgroundColor: colors.surface, color: colors.text, textAlign: 'center' }]}
                                value={editPseudo}
                                onChangeText={setEditPseudo}
                                placeholder="Votre pseudo..."
                                placeholderTextColor={colors.textSecondary}
                            />
                        </View>
                        <TouchableOpacity onPress={() => setIsEditing(false)}>
                            <Text style={{ color: colors.textSecondary, marginTop: 5 }}>Annuler</Text>
                        </TouchableOpacity>
                    </View>
                ) : (
                    <>
                        <Text style={{ fontSize: 24, fontWeight: 'bold', marginBottom: 5, color: colors.text }}>{pseudo}</Text>
                        <View style={{ height: 20 }} />
                    </>
                )}

                {!isEditing && (
                    <>
                        {/* ID SECTION */}
                        <View style={{ width: '100%', marginBottom: 30, alignItems: 'center' }}>
                            {!showID ? (
                                <TouchableOpacity
                                    onPress={() => setShowID(true)}
                                    style={{ backgroundColor: colors.surface, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border }}
                                >
                                    <Text style={{ color: colors.primary, fontWeight: '600' }}>Afficher mon ID</Text>
                                </TouchableOpacity>
                            ) : (
                                <View style={{ width: '100%', alignItems: 'center' }}>
                                    <Text style={styles.label}>MON ID</Text>
                                    <View style={{
                                        flexDirection: 'row', alignItems: 'center',
                                        backgroundColor: isDark ? '#2C2C2E' : '#f5f5f5', borderRadius: 12,
                                        borderWidth: 1, borderColor: colors.border,
                                        padding: 4, width: '100%'
                                    }}>
                                        <TextInput
                                            style={{ flex: 1, padding: 10, fontSize: 13, color: colors.text, textAlign: 'center' }}
                                            value={myID}
                                            editable={false}
                                        />
                                        <TouchableOpacity
                                            onPress={copyToClipboard}
                                            style={{ backgroundColor: colors.primary, padding: 8, borderRadius: 8, marginRight: 2 }}
                                        >
                                            <Text style={{ color: 'white', fontSize: 12, fontWeight: 'bold' }}>Copier</Text>
                                        </TouchableOpacity>
                                    </View>
                                    <TouchableOpacity onPress={() => setShowID(false)} style={{ marginTop: 10 }}>
                                        <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Masquer</Text>
                                    </TouchableOpacity>
                                </View>
                            )}
                        </View>

                        {/* QR CODE SECTION */}
                        <View style={{ width: '100%', alignItems: 'center', marginBottom: 20 }}>
                            {!showQR ? (
                                <TouchableOpacity
                                    onPress={() => setShowQR(true)}
                                    style={{ backgroundColor: colors.surface, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border }}
                                >
                                    <Text style={{ color: colors.primary, fontWeight: '600' }}>Afficher mon QR Code</Text>
                                </TouchableOpacity>
                            ) : (
                                <>
                                    <View style={{ backgroundColor: 'white', padding: 20, borderRadius: 20, shadowColor: "#000", shadowOpacity: 0.1, shadowRadius: 10, elevation: 5, marginBottom: 10, marginTop: 10 }}>
                                        {qrValue ? (
                                            <QRCode value={qrValue} size={200} backgroundColor='white' color='black' />
                                        ) : (
                                            <View style={{ width: 200, height: 200, backgroundColor: '#eee' }} />
                                        )}
                                    </View>
                                    <Text style={{ color: colors.textSecondary, marginBottom: 10, textAlign: 'center' }}>
                                        Scannez ce code pour m'ajouter
                                    </Text>
                                    <TouchableOpacity onPress={() => setShowQR(false)} style={{ marginBottom: 20 }}>
                                        <Text style={{ color: colors.textSecondary, fontSize: 14 }}>Masquer le QR Code</Text>
                                    </TouchableOpacity>
                                </>
                            )}
                        </View>
                    </>
                )}

            </ScrollView>
        </View>
    );
}
