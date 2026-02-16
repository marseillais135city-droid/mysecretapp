import { getGhostStyles } from '@/components/GhostTheme';
import LockScreen from '@/components/LockScreen';
import { AVATARS } from '@/constants/Avatars';
import { useTheme } from '@/context/ThemeContext';
import { ensureRegistered, generateNewIdentity } from '@/utils/AuthHelper';
import { secureSet } from '@/utils/SecureStorage';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Alert, Image, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';

const APP_LOCK_KEY = "my_app_lock_pin_v1";
const PROFILE_KEY = "my_profile_data_v1";

export default function OnboardingScreen() {
    const { colors } = useTheme();
    const styles = useMemo(() => getGhostStyles(colors), [colors]);
    const router = useRouter();
    const [pseudo, setPseudo] = useState("");
    const [selectedAvatar, setSelectedAvatar] = useState(AVATARS[0]);
    const [showLockSetup, setShowLockSetup] = useState(false);

    const handleNext = () => {
        if (!pseudo.trim()) return;

        // Ask for Lock
        Alert.alert(
            "Sécuriser MySecretApp ?",
            "Voulez-vous définir un code PIN pour protéger l'accès à l'application ?",
            [
                { text: "Non, plus tard", style: "cancel", onPress: finishOnboarding },
                { text: "Oui, sécuriser", onPress: () => setShowLockSetup(true) }
            ]
        );
    };

    const finishOnboarding = async () => {
        // Sanitize pseudo: trim, limit length, remove control chars
        const safePseudo = pseudo.trim().substring(0, 50).replace(/[\x00-\x1F\x7F]/g, '');
        const profile = {
            pseudo: safePseudo,
            avatar: selectedAvatar
        };

        try {
            // Ensure crypto keys are generated and registered before storing profile
            await generateNewIdentity();
            await ensureRegistered();
            // Store profile using encrypted storage (not plain AsyncStorage)
            await secureSet(PROFILE_KEY, JSON.stringify(profile));
            // Navigate to main app
            router.replace('/(tabs)');
        } catch (e) {
            console.error("Failed to save profile", e);
            Alert.alert("Erreur", "Impossible de sauvegarder le profil. Réessayez.");
        }
    };

    const pickImage = async () => {
        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.5,
        });

        if (!result.canceled) {
            const asset = result.assets[0];
            try {
                const b64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: 'base64' });
                setSelectedAvatar(`data:image/jpeg;base64,${b64}`);
            } catch (err) {
                console.error("Failed to read image", err);
            }
        }
    };

    if (showLockSetup) {
        return (
            <LockScreen
                isSetup={true}
                onUnlock={finishOnboarding}
                onCancel={() => setShowLockSetup(false)}
            />
        );
    }

    return (
        <View style={[styles.container, { paddingTop: 100, alignItems: 'center' }]}>
            <Text style={{ fontSize: 28, fontWeight: 'bold', color: colors.text, marginBottom: 10 }}>Bienvenue</Text>
            <Text style={{ fontSize: 16, color: colors.textSecondary, marginBottom: 40, textAlign: 'center', paddingHorizontal: 40 }}>
                Choisissez votre identité pour commencer à échanger en toute sécurité.
            </Text>

            <View style={{ marginBottom: 30 }}>
                <Image
                    source={{ uri: selectedAvatar }}
                    style={{ width: 120, height: 120, borderRadius: 60, backgroundColor: colors.border }}
                />
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 70 }}>
                    {AVATARS.map((uri, index) => (
                        <TouchableOpacity key={index} onPress={() => setSelectedAvatar(uri)} style={{ marginHorizontal: 10 }}>
                            <Image source={{ uri }} style={{ width: 60, height: 60, borderRadius: 30, borderWidth: selectedAvatar === uri ? 3 : 0, borderColor: colors.primary }} />
                        </TouchableOpacity>
                    ))}
                </ScrollView>
            </View>

            <TouchableOpacity
                onPress={pickImage}
                style={{
                    backgroundColor: colors.surface,
                    paddingHorizontal: 20,
                    paddingVertical: 10,
                    borderRadius: 20,
                    marginBottom: 30,
                    borderWidth: 1,
                    borderColor: colors.primary + '40'
                }}
            >
                <Text style={{ color: colors.primary, fontWeight: 'bold' }}>📸 Choisir depuis la galerie</Text>
            </TouchableOpacity>

            <View style={{ width: '80%', marginBottom: 30 }}>
                <Text style={styles.label}>PSEUDO</Text>
                <TextInput
                    style={[styles.input, { textAlign: 'center', backgroundColor: colors.surface, color: colors.text }]}
                    value={pseudo}
                    onChangeText={setPseudo}
                    placeholder="Votre nom..."
                    placeholderTextColor={colors.textSecondary}
                />
            </View>

            <TouchableOpacity
                style={[styles.buttonPrimary, { width: '80%', opacity: pseudo.trim() ? 1 : 0.5 }]}
                onPress={handleNext}
                disabled={!pseudo.trim()}
            >
                <Text style={styles.buttonText}>COMMENCER</Text>
            </TouchableOpacity>
        </View>
    );
}
