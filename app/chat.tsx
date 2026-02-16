import nacl from '@/components/CryptoPolyfill';
import { getGhostStyles } from '@/components/GhostTheme';
import { getServerURL } from '@/constants/Config';
import { useTheme } from '@/context/ThemeContext';
import { authFetch, getBoxSecretKey, getMyID } from '@/utils/AuthHelper';
import { useScreenshotDetection } from '@/utils/ScreenshotDetector';
import { secureGet, secureSet } from '@/utils/SecureStorage';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { encode as encodeBase64 } from 'base-64';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, FlatList, Image, Keyboard, KeyboardAvoidingView, Modal, PanResponder, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

const stringToUint8Array = (str: string) => { const bytes = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xFF; return bytes; };
const uint8ArrayToString = (arr: Uint8Array) => { let str = ''; for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]); return str; };

const CONTACTS_KEY = "my_contacts_list_v1";


interface Message {
  id: string;
  text: string;
  timestamp: number;
  isMe: boolean;
  localUri?: string;
  mediaType?: string;
  status?: 'sending' | 'sent' | 'read';
}

const ChatVideo = ({ uri, onPress }: { uri: string, onPress: () => void }) => {
  const player = useVideoPlayer(uri, (player) => {
    player.loop = true;
    player.muted = true;
    player.play();
  });

  return (
    <TouchableOpacity onPress={onPress}>
      <VideoView
        player={player}
        style={{ width: 200, height: 200, borderRadius: 8 }}
        nativeControls={false}
      />
    </TouchableOpacity>
  );
};

const VideoPreview = ({ uri }: { uri: string }) => {
  const player = useVideoPlayer(uri, (player) => {
    player.muted = true;
    player.play();
  });
  return <VideoView player={player} style={{ width: 100, height: 100, borderRadius: 8 }} nativeControls={false} />;
};

const FullScreenVideo = ({ uri }: { uri: string }) => {
  const player = useVideoPlayer(uri, (player) => {
    player.loop = true;
    player.play();
  });
  return <VideoView player={player} style={{ width: '100%', height: '100%' }} nativeControls={true} />;
};


const formatTimeRemaining = (timestamp: number, timerSeconds: number): string => {
  const expiresAt = timestamp + (timerSeconds * 1000);
  const remaining = Math.max(0, expiresAt - Date.now());
  if (remaining <= 0) return "expiré";
  const secs = Math.floor(remaining / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}j`;
};

export default function ChatScreen() {
  const { colors } = useTheme();
  const ghostStyles = useMemo(() => getGhostStyles(colors), [colors]);
  const chatStyles = useMemo(() => getChatStyles(colors), [colors]);

  const router = useRouter();
  const { contactId, contactKey, contactName, contactAvatar } = useLocalSearchParams();
  const [messages, setMessages] = useState<Message[]>([]);
  const [message, setMessage] = useState("");
  const [myID, setMyID] = useState("");
  const myKeyRef = useRef<Uint8Array | null>(null);
  const [currentContact, setCurrentContact] = useState({
    name: (contactName as string) || "Chargement...",
    avatar: (contactAvatar as string) || null
  });
  const [pendingMedia, setPendingMedia] = useState<{ uri: string, type: string, b64: string } | null>(null);
  const [viewerMedia, setViewerMedia] = useState<{ uri: string, type: string } | null>(null);
  const [isSending, setIsSending] = useState(false);
  const flatListRef = useRef<FlatList>(null);
  const panY = useRef(new Animated.Value(0)).current;
  const [allowReadReceipts, setAllowReadReceipts] = useState(true);
  const [contactStatus, setContactStatus] = useState<{ isOnline: boolean, lastSeen: number | null }>({ isOnline: false, lastSeen: null });
  const [ephemeralTimer, setEphemeralTimer] = useState<number | null>(null);
  const [screenshotDetection, setScreenshotDetection] = useState(false);

  useEffect(() => {
    SecureStore.getItemAsync("privacy_read_receipts").then(val => {
      setAllowReadReceipts(val !== "false");
    });
    SecureStore.getItemAsync("security_screenshot_detection").then(val => {
      setScreenshotDetection(val === "true");
    });
    // Load ephemeral timer for this conversation
    if (contactId) {
      SecureStore.getItemAsync(`ephemeral_timer_${contactId}`).then(val => {
        setEphemeralTimer(val ? parseInt(val) : null);
      });
    }
  }, [contactId]);

  // Screenshot detection: notify the contact when a screenshot is taken
  const sendScreenshotSignal = async () => {
    if (!myKeyRef.current || !contactKey || !myID) return;
    try {
      const serverURL = await getServerURL();
      const nonce = nacl.randomBytes(nacl.box.nonceLength);
      const signal = `GHOST_SIGNAL:SCREENSHOT:${Date.now()}`;

      const pk = typeof contactKey === 'string' ? contactKey : contactKey[0];
      const peerPublicKeyBytes = new Uint8Array(pk.match(/.{1,2}/g)!.map((byte: string) => parseInt(byte, 16)));

      const encrypted = nacl.box(stringToUint8Array(signal), nonce, peerPublicKeyBytes, myKeyRef.current!);
      const fullMessage = new Uint8Array(nonce.length + encrypted.length);
      fullMessage.set(nonce); fullMessage.set(encrypted, nonce.length);

      await authFetch(`${serverURL}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: contactId,
          encryptedContent: encodeBase64(uint8ArrayToString(fullMessage))
        })
      });

      // Also save a local notification message
      const screenshotMsg: Message = {
        id: `screenshot_${Date.now()}`,
        text: '📸 Vous avez pris une capture d\'écran',
        timestamp: Date.now(),
        isMe: true,
        status: 'sent'
      };
      await saveMessageToStorage(screenshotMsg);
    } catch (e) {
      console.error("[SCREENSHOT] Failed to send signal", e);
    }
  };

  useScreenshotDetection(screenshotDetection, sendScreenshotSignal);



  useEffect(() => {
    loadIdentity();
    loadHistory();
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!contactId) return;
      loadContactInfo();
      loadHistory();
      markAsRead();
    }, [contactId])
  );

  useEffect(() => {
    if (!contactId) return;

    // Keep polling for background message reception
    const interval = setInterval(() => {
      loadHistory();
      markAsRead();
      sendReadSignal();
      loadOnlineStatus();
      cleanExpiredMessages();
    }, 2000);

    return () => clearInterval(interval);
  }, [contactId, myID, ephemeralTimer]);


  const loadContactInfo = async () => {
    try {
      const json = await secureGet(CONTACTS_KEY);
      if (json) {
        const list = JSON.parse(json);
        const c = list.find((item: any) => item.id === contactId);
        if (c) {
          setCurrentContact({ name: c.alias || c.name, avatar: c.avatar });
        }
      }
    } catch (e) { }
  };


  // Use AuthHelper instead of directly loading keys into component state
  const loadIdentity = async () => {
    const id = await getMyID();
    const secretKey = await getBoxSecretKey();
    if (id && secretKey) {
      setMyID(id);
      myKeyRef.current = secretKey;
    }
  };

  const sendReadSignal = async () => {
    if (!myKeyRef.current || !contactKey || !myID) return;

    // Privacy Check: Do not send read receipt if disabled
    const privacy = await SecureStore.getItemAsync("privacy_read_receipts");
    if (privacy === "false") return;

    try {
      const serverURL = await getServerURL();
      const nonce = nacl.randomBytes(nacl.box.nonceLength);
      const signal = `GHOST_SIGNAL:READ:${Date.now()}`;

      const pk = typeof contactKey === 'string' ? contactKey : contactKey[0];
      const peerPublicKeyBytes = new Uint8Array(pk.match(/.{1,2}/g)!.map((byte: string) => parseInt(byte, 16)));

      const encrypted = nacl.box(stringToUint8Array(signal), nonce, peerPublicKeyBytes, myKeyRef.current!);
      const fullMessage = new Uint8Array(nonce.length + encrypted.length);
      fullMessage.set(nonce); fullMessage.set(encrypted, nonce.length);

      await authFetch(`${serverURL}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: contactId,
          encryptedContent: encodeBase64(uint8ArrayToString(fullMessage))
        })
      });
    } catch (e) { }
  };

  // Clean up expired ephemeral messages
  const cleanExpiredMessages = async () => {
    if (!ephemeralTimer || !contactId) return;
    try {
      const key = `history_${contactId}`;
      const stored = await secureGet(key);
      if (!stored) return;
      const history: Message[] = JSON.parse(stored);
      const now = Date.now();
      const expiryMs = ephemeralTimer * 1000; // timer is in seconds
      const filtered = history.filter(m => (now - m.timestamp) < expiryMs);
      if (filtered.length < history.length) {
        await secureSet(key, JSON.stringify(filtered));
        setMessages(filtered);
      }
    } catch (e) {
      console.error("[EPHEMERAL] Cleanup error", e);
    }
  };

  const loadOnlineStatus = async () => {
    try {
      const json = await AsyncStorage.getItem("contact_presence");
      if (json) {
        const presenceData = JSON.parse(json);
        if (presenceData[contactId as string]) {
          setContactStatus(presenceData[contactId as string]);
        }
      }
    } catch (e) { }
  };

  const loadHistory = async () => {
    const key = `history_${contactId}`;
    const stored = await secureGet(key);
    if (stored) setMessages(JSON.parse(stored));
  };

  /* ... existing loadHistory ... */

  const markAsRead = async () => {
    try {
      const key = `last_read_${contactId}`;
      await secureSet(key, Date.now().toString());
    } catch (e) {
      // Silently fail if encryption key not ready yet
    }
  };

  useEffect(() => {
    markAsRead();
    sendReadSignal();
  }, [contactId, myID]); // Send read signal when entering chat

  const saveMessageToStorage = async (msg: Message) => {
    const key = `history_${contactId}`;
    const stored = await secureGet(key);
    const history = stored ? JSON.parse(stored) : [];

    // Avoid duplicates
    if (history.find((m: any) => m.id === msg.id)) return;

    const updated = [msg, ...history];
    setMessages(updated);
    await secureSet(key, JSON.stringify(updated));

    // Since we are IN the chat, mark as read immediately
    markAsRead();
  };

  const send = async () => {
    if ((!message.trim() && !pendingMedia) || !myKeyRef.current) return;
    const serverURL = await getServerURL();
    setIsSending(true);

    try {
      let contentToSend = message.trim();
      let mediaData = null;

      if (pendingMedia) {
        // Format: GHOST_MEDIA:TYPE:BASE64:CAPTION
        contentToSend = `GHOST_MEDIA:${pendingMedia.type}:${pendingMedia.b64}:${message.trim()}`;
        mediaData = { uri: pendingMedia.uri, type: pendingMedia.type };
      }

      const nonce = nacl.randomBytes(nacl.box.nonceLength);
      const msgBytes = stringToUint8Array(contentToSend);

      const pk = typeof contactKey === 'string' ? contactKey : contactKey[0];
      const peerPublicKeyBytes = new Uint8Array(pk.match(/.{1,2}/g)!.map((byte: string) => parseInt(byte, 16)));

      const encrypted = nacl.box(msgBytes, nonce, peerPublicKeyBytes, myKeyRef.current!);

      const fullMessage = new Uint8Array(nonce.length + encrypted.length);
      fullMessage.set(nonce);
      fullMessage.set(encrypted, nonce.length);

      const base64Content = encodeBase64(uint8ArrayToString(fullMessage));

      const res = await authFetch(`${serverURL}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: contactId,
          encryptedContent: base64Content
        })
      });


      if (res.ok) {
        let storedText = contentToSend;
        if (pendingMedia) {
          storedText = `GHOST_MEDIA_REF:${pendingMedia.type}:${pendingMedia.uri}:${message.trim()}`;
        }

        const newMsg: Message = {
          id: `${Date.now()}_${Array.from(Crypto.getRandomBytes(8)).map(b => b.toString(16).padStart(2, '0')).join('')}`,
          text: storedText,
          timestamp: Date.now(),
          isMe: true,
          localUri: mediaData?.uri,
          mediaType: mediaData?.type,
          status: 'sent'
        };
        await saveMessageToStorage(newMsg);
        setMessage("");
        setPendingMedia(null);
      } else {
        Alert.alert("Erreur", "Erreur serveur lors de l'envoi du message.");
      }

    } catch (e) {
      console.error("Encryption failed", e);
      Alert.alert("Erreur", "Échec de l'envoi. Vérifiez votre connexion.");
    } finally {
      setIsSending(false);
    }
  };


  const pickMedia = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      quality: 0.6,
      base64: true,
    });

    if (!result.canceled) {
      const asset = result.assets[0];
      const type = asset.type === 'video' ? 'VIDEO' : 'IMAGE';

      let b64 = asset.base64;
      if (!b64 && asset.uri) {
        b64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: 'base64' });
      }

      if (b64) {
        setPendingMedia({ uri: asset.uri, type, b64: b64 || "" });
      }
    }
  };

  // Save media to device gallery
  const saveMediaToGallery = async (uri: string) => {
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert("Permission requise", "L'accès à la galerie est nécessaire pour enregistrer le média.");
        return;
      }

      let fileToSave = uri;

      // If it's a base64 data URI, we must save it as a temporary file first
      if (uri.startsWith('data:')) {
        const parts = uri.split(';base64,');
        if (parts.length < 2) throw new Error("Format Base64 invalide");
        const b64 = parts[1];
        const extension = uri.includes('video') ? 'mp4' : 'jpg';
        const filename = `temp_save_${Date.now()}.${extension}`;
        const tempUri = ((FileSystem as any).documentDirectory || (FileSystem as any).cacheDirectory || "") + filename;

        await FileSystem.writeAsStringAsync(tempUri, b64, { encoding: 'base64' });
        fileToSave = tempUri;
      }

      // Ensure file:// prefix for local files
      if (fileToSave && !fileToSave.startsWith('file://') && !fileToSave.startsWith('data:')) {
        fileToSave = 'file://' + fileToSave;
      }

      const asset = await MediaLibrary.createAssetAsync(fileToSave);
      await MediaLibrary.createAlbumAsync("MySecretApp", asset, false);
      Alert.alert("Succès", "Média enregistré dans la galerie !");
    } catch (err) {
      console.error("Save failed", err);
      Alert.alert("Erreur", "Impossible d'enregistrer le média.");
    }
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderMove: (_, gestureState) => {
        if (gestureState.dy > 0) {
          panY.setValue(gestureState.dy);
        }
      },
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dy > 150) {
          setViewerMedia(null);
          panY.setValue(0);
        } else {
          Animated.spring(panY, {
            toValue: 0,
            useNativeDriver: false,
          }).start();
        }
      },
    })
  ).current;

  return (
    <View style={ghostStyles.container}>
      {/* HEADER */}
      <View style={ghostStyles.header}>
        <TouchableOpacity onPress={() => router.back()} style={{ paddingRight: 10 }}>
          <Text style={{ color: colors.primary, fontSize: 17, fontWeight: '600' }}>Retour</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center' }}
          onPress={() => router.push({
            pathname: "/contact-details",
            params: { contactId }
          })}
        >
          <View style={{ width: 36, height: 36, borderRadius: 18, overflow: 'hidden', marginRight: 10, backgroundColor: colors.border }}>
            {currentContact.avatar ? (
              <Image source={{ uri: currentContact.avatar }} style={{ width: '100%', height: '100%' }} />
            ) : (
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 18, color: colors.textSecondary }}>👤</Text></View>
            )}
          </View>
          <View>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ color: colors.text, fontSize: 17, fontWeight: '600' }}>{currentContact.name}</Text>
              {contactStatus.isOnline && (
                <View style={{
                  width: 10,
                  height: 10,
                  borderRadius: 5,
                  backgroundColor: '#4CAF50',
                  marginLeft: 6,
                  borderWidth: 1,
                  borderColor: colors.surface
                }} />
              )}
            </View>

            {contactStatus.isOnline ? (
              <Text style={{ fontSize: 12, color: colors.textSecondary }}>
                En ligne{ephemeralTimer ? ' · ⏱️' : ''}
              </Text>
            ) : contactStatus.lastSeen ? (
              <Text style={{ fontSize: 12, color: colors.textSecondary }}>
                Vu à {new Date(contactStatus.lastSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{ephemeralTimer ? ' · ⏱️' : ''}
              </Text>
            ) : ephemeralTimer ? (
              <Text style={{ fontSize: 12, color: colors.textSecondary }}>⏱️ Éphémère</Text>
            ) : null}
          </View>
        </TouchableOpacity>


        <View style={{ width: 50 }} />
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
        style={{ flex: 1 }}
      >
        <FlatList
          ref={flatListRef}
          data={messages}
          inverted
          style={{ flex: 1, backgroundColor: colors.background }}
          contentContainerStyle={{ paddingVertical: 10, paddingHorizontal: 10 }}
          keyExtractor={item => item.id}
          renderItem={({ item }) => {
            const isMedia = item.text?.startsWith("GHOST_MEDIA:");
            const isMediaRef = item.text?.startsWith("GHOST_MEDIA_REF:");
            let mediaType = "";
            let mediaUri = item.localUri;
            let caption = "";

            if (isMedia && !mediaUri) {
              const parts = item.text.split(":");
              mediaType = parts[1];
              mediaUri = `data:${mediaType === 'VIDEO' ? 'video/mp4' : 'image/jpeg'};base64,${parts[2]}`;
              caption = parts[3] || "";
            } else if (isMediaRef) {
              const parts = item.text.split(":");
              mediaType = parts[1];
              // mediaUri is at index 2, but could contain colons (file://)
              // Caption is the last part
              caption = parts[parts.length - 1];
              mediaUri = parts.slice(2, parts.length - 1).join(":");
            }

            return (
              <View style={[
                chatStyles.bubble,
                item.isMe ? chatStyles.bubbleMe : chatStyles.bubbleThem,
                (isMedia || isMediaRef) && { padding: 4, borderRadius: 12 }
              ]}>
                {(isMedia || isMediaRef) ? (
                  <View>
                    {mediaType === 'VIDEO' || item.mediaType === 'VIDEO' ? (
                      <ChatVideo
                        uri={mediaUri || ""}
                        onPress={() => setViewerMedia({ uri: mediaUri || "", type: mediaType || item.mediaType || "" })}
                      />
                    ) : (
                      <TouchableOpacity onPress={() => setViewerMedia({ uri: mediaUri || "", type: mediaType || item.mediaType || "" })}>
                        <Image source={{ uri: mediaUri }} style={{ width: 200, height: 200, borderRadius: 8 }} />
                      </TouchableOpacity>
                    )}
                    {caption ? (
                      <Text style={[item.isMe ? chatStyles.textMe : chatStyles.textThem, { marginTop: 4, paddingHorizontal: 6, paddingBottom: 4 }]}>
                        {caption}
                      </Text>
                    ) : null}
                  </View>
                ) : (
                  <Text style={item.isMe ? chatStyles.textMe : chatStyles.textThem}>{item.text}</Text>
                )}
                {item.isMe && (
                  <Text style={{ fontSize: 10, color: colors.bubbleTextMe, alignSelf: 'flex-end', marginTop: 2, opacity: 0.7 }}>
                    {item.status === 'read' && allowReadReceipts ? '✓✓ Lu' : '✓ Envoyé'}
                  </Text>
                )}
                {ephemeralTimer && (
                  <Text style={{ fontSize: 9, color: item.isMe ? colors.bubbleTextMe : colors.bubbleTextThem, alignSelf: 'flex-end', marginTop: 1, opacity: 0.5 }}>
                    ⏱️ {formatTimeRemaining(item.timestamp, ephemeralTimer)}
                  </Text>
                )}
              </View>
            );
          }}
        />

        {pendingMedia && (
          <View style={chatStyles.previewContainer}>
            <View style={chatStyles.previewWrapper}>
              {pendingMedia.type === 'VIDEO' ? (
                <VideoPreview uri={pendingMedia.uri} />
              ) : (
                <Image source={{ uri: pendingMedia.uri }} style={chatStyles.previewImage} />
              )}
              <TouchableOpacity onPress={() => setPendingMedia(null)} style={chatStyles.removePreview}>
                <Text style={{ color: 'white', fontWeight: 'bold' }}>✕</Text>
              </TouchableOpacity>
              {isSending && (
                <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', borderRadius: 8 }]}>
                  <ActivityIndicator color="white" />
                </View>
              )}
            </View>
          </View>
        )}

        <View style={chatStyles.inputContainer}>
          <TouchableOpacity onPress={pickMedia} style={chatStyles.mediaButton}>
            <Text style={{ fontSize: 24, color: colors.primary }}>+</Text>
          </TouchableOpacity>
          <TextInput
            style={[ghostStyles.input, { flex: 1, backgroundColor: colors.background === '#000000' ? '#2C2C2E' : '#E5E5EA' }]}
            value={message}
            onChangeText={setMessage}
            placeholder="Message..."
            placeholderTextColor={colors.textSecondary}
            multiline
          />
          <TouchableOpacity onPress={send} style={chatStyles.sendButton} disabled={isSending}>
            {isSending ? (
              <ActivityIndicator color="white" size="small" />
            ) : (
              <Text style={{ fontSize: 20, color: '#FFFFFF', fontWeight: 'bold' }}>↑</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => Keyboard.dismiss()} style={{ marginLeft: 8, padding: 8 }}>
            <Text style={{ fontSize: 20 }}>⌨️</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      {/* FULL SCREEN SENDING OVERLAY */}
      {isSending && (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', zIndex: 999 }]}>
          <View style={{ backgroundColor: colors.surface, padding: 30, borderRadius: 20, alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 10, elevation: 10 }}>
            <ActivityIndicator color={colors.primary} size="large" />
            <Text style={{ color: colors.text, marginTop: 15, fontWeight: 'bold' }}>Chiffrement et envoi...</Text>
            <Text style={{ color: colors.textSecondary, marginTop: 5, fontSize: 12 }}>Une vidéo volumineuse peut prendre du temps.</Text>
          </View>
        </View>
      )}

      {/* FULL SCREEN VIEWER */}
      <Modal
        visible={!!viewerMedia}
        transparent={false}
        animationType="fade"
        onRequestClose={() => setViewerMedia(null)}
        statusBarTranslucent={true}
      >

        <View style={chatStyles.viewerContainer}>
          <TouchableOpacity style={chatStyles.viewerClose} onPress={() => setViewerMedia(null)}>
            <Text style={{ color: 'white', fontSize: 24, fontWeight: 'bold' }}>✕</Text>
          </TouchableOpacity>

          {viewerMedia && (
            <TouchableOpacity
              style={chatStyles.viewerSave}
              onPress={() => saveMediaToGallery(viewerMedia.uri)}
            >
              <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 16 }}>💾 Enregistrer</Text>
            </TouchableOpacity>
          )}

          <Animated.View
            style={[
              { transform: [{ translateY: panY }] },
              chatStyles.viewerContent
            ]}
            {...panResponder.panHandlers}
          >

            {viewerMedia?.type === 'VIDEO' ? (
              <FullScreenVideo uri={viewerMedia.uri} />
            ) : (
              viewerMedia && <Image source={{ uri: viewerMedia.uri }} style={chatStyles.viewerMedia} resizeMode="contain" />
            )}
          </Animated.View>
        </View>
      </Modal>
    </View>
  );
}



const getChatStyles = (colors: any) => StyleSheet.create({
  bubble: {
    padding: 10,
    paddingHorizontal: 14,
    borderRadius: 18,
    marginVertical: 2,
    maxWidth: '75%',
  },
  bubbleMe: {
    alignSelf: 'flex-end',
    backgroundColor: colors.bubbleMe,
    borderBottomRightRadius: 4,
  },
  bubbleThem: {
    alignSelf: 'flex-start',
    backgroundColor: colors.bubbleThem,
    borderBottomLeftRadius: 4,
  },
  textMe: {
    color: colors.bubbleTextMe,
    fontSize: 16,
  },
  textThem: {
    color: colors.bubbleTextThem,
    fontSize: 16,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 10,
    backgroundColor: colors.surface, // Input bar always white/surface
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingBottom: Platform.OS === "ios" ? 30 : 10, // Safe area
  },
  sendButton: {
    backgroundColor: colors.primary,
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 10,
    marginBottom: 4, // Align with single line input
  },
  mediaButton: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
    marginBottom: 4,
  },
  previewContainer: {
    padding: 10,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  previewWrapper: {
    width: 100,
    height: 100,
    borderRadius: 8,
    position: 'relative',
  },
  previewImage: {
    width: '100%',
    height: '100%',
    borderRadius: 8,
  },
  removePreview: {
    position: 'absolute',
    top: -8,
    right: -8,
    backgroundColor: 'red',
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  viewerContainer: {
    flex: 1,
    backgroundColor: 'black',
    justifyContent: 'center',
    alignItems: 'center',
  },
  viewerClose: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 60 : 40,
    right: 20,
    zIndex: 20,
    backgroundColor: 'rgba(255,255,255,0.2)',
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  viewerSave: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 60 : 40,
    left: 20,
    zIndex: 20,
    backgroundColor: colors.primary,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 25,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.8,
    shadowRadius: 4,
    elevation: 5,
  },
  viewerContent: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  viewerMedia: {
    width: '100%',
    height: '100%',
  }
});