import nacl from '@/components/CryptoPolyfill';
import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { getServerURL } from '@/constants/Config';
import { useTheme } from '@/context/ThemeContext';
import { authFetch, ensureRegistered, getBoxSecretKey, getMyID } from '@/utils/AuthHelper';
import { getBadgeCounts } from '@/utils/BadgeManager';
import { secureClear, secureGet, secureSet } from '@/utils/SecureStorage';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { decode as decodeBase64 } from 'base-64';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import { Tabs } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Alert, Platform } from 'react-native';

const CONTACTS_KEY = "my_contacts_list_v1";
const CONTACT_REQUESTS_KEY = "my_contact_requests_v1";

const stringToUint8Array = (str: string) => { const bytes = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xFF; return bytes; };
const toHex = (buffer: ArrayBuffer | Uint8Array) => Array.prototype.map.call(new Uint8Array(buffer), (x: number) => ('00' + x.toString(16)).slice(-2)).join('');
const uint8ArrayToString = (arr: Uint8Array) => { let str = ''; for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]); return str; };


export default function TabLayout() {
  const { colors, isDark } = useTheme();
  const [messagesBadge, setMessagesBadge] = useState(0);
  const [requestsBadge, setRequestsBadge] = useState(0);

  useEffect(() => {
    // Ensure registration on mount
    ensureRegistered();

    const interval = setInterval(() => {
      checkGlobalMessages();
      checkGlobalRequests();
      sendHeartbeat();
      checkContactStatus();
      updateBadge();
      cleanExpiredEphemeralMessages();
    }, 5000);

    checkGlobalMessages();
    checkGlobalRequests();
    sendHeartbeat();
    checkContactStatus();
    updateBadge();

    return () => clearInterval(interval);
  }, []);


  // Clean expired ephemeral messages for all conversations
  const cleanExpiredEphemeralMessages = async () => {
    try {
      const json = await secureGet(CONTACTS_KEY);
      if (!json) return;
      const contacts = JSON.parse(json);
      const now = Date.now();

      for (const contact of contacts) {
        const timerStr = await SecureStore.getItemAsync(`ephemeral_timer_${contact.id}`);
        if (!timerStr) continue;

        const timerSeconds = parseInt(timerStr);
        if (!timerSeconds || timerSeconds <= 0) continue;

        const expiryMs = timerSeconds * 1000;
        const historyKey = `history_${contact.id}`;
        const historyJson = await secureGet(historyKey);
        if (!historyJson) continue;

        const history = JSON.parse(historyJson);
        const filtered = history.filter((m: any) => (now - m.timestamp) < expiryMs);

        if (filtered.length < history.length) {
          if (filtered.length === 0) {
            await secureClear(historyKey);
          } else {
            await secureSet(historyKey, JSON.stringify(filtered));
          }
        }
      }
    } catch (e) {
      // Silently fail - background cleanup
    }
  };

  const checkGlobalMessages = async () => {
    try {
      const secretKey = await getBoxSecretKey();
      const myID = await getMyID();
      if (!secretKey || !myID) return;

      const serverURL = await getServerURL();
      const res = await authFetch(`${serverURL}/check/${myID}`, { method: 'GET' });
      if (!res.ok) return;
      const messages = await res.json();
      if (messages.length === 0) return;

      const json = await secureGet(CONTACTS_KEY);
      const contacts = json ? JSON.parse(json) : [];
      const processedIds: number[] = [];

      for (const msg of messages) {
        let decrypted = null;
        let sender: any = null;

        const fullMessage = new Uint8Array(stringToUint8Array(decodeBase64(msg.content)));
        const nonce = fullMessage.slice(0, nacl.box.nonceLength);
        const ciphertext = fullMessage.slice(nacl.box.nonceLength, fullMessage.length);

        for (const contact of contacts) {
          if (contact.isSelf) continue;
          try {
            const peerKey = new Uint8Array(contact.key.match(/.{1,2}/g).map((byte: any) => parseInt(byte, 16)));
            const result = nacl.box.open(ciphertext, nonce, peerKey, secretKey);
            if (result) {
              decrypted = uint8ArrayToString(result);
              sender = contact;
              break;
            }
          } catch (e) { }
        }

        // Anonymous handshake: [SENDER_PK(32)] + [NONCE(24)] + [ENCRYPTED_DATA]
        if (!decrypted && fullMessage.length > 32 + 24) {
          try {
            const claimedPubKey = fullMessage.slice(0, 32);
            const handshakeNonce = fullMessage.slice(32, 32 + 24);
            const handshakeCipher = fullMessage.slice(32 + 24);
            const result = nacl.box.open(handshakeCipher, handshakeNonce, claimedPubKey, secretKey);
            if (result) {
              const text = uint8ArrayToString(result);
              if (text.startsWith("GHOST_SIGNAL:ACCEPT:")) {
                // Validate the handshake data before accepting
                try {
                  const jsonStr = text.substring("GHOST_SIGNAL:ACCEPT:".length);
                  const hsData = JSON.parse(jsonStr);
                  // Verify the claimed public key in the message matches the key used for encryption
                  const claimedKeyHex = toHex(claimedPubKey);
                  if (hsData.key && hsData.key.toLowerCase() === claimedKeyHex.toLowerCase()) {
                    decrypted = text;
                  } else {
                    console.warn("[HANDSHAKE] Key mismatch: claimed key does not match encryption key");
                  }
                } catch (parseErr) {
                  console.warn("[HANDSHAKE] Invalid handshake data format");
                }
              }
            }
          } catch (e) {
            // Handshake decryption failed - not for us or malformed
          }
        }

        if (decrypted) {
          // Mark message as processed
          if (msg.id) processedIds.push(msg.id);

          if (decrypted.startsWith("GHOST_SIGNAL:")) {
            const parts = decrypted.split(":");
            const type = parts[1];

            if (type === "ACCEPT") {
              let jsonStr = "";
              if (decrypted.startsWith("GHOST_SIGNAL:ACCEPT:")) {
                jsonStr = decrypted.substring("GHOST_SIGNAL:ACCEPT:".length);
              } else {
                jsonStr = decrypted.substring("GHOST_SIGNAL:ACCEPT".length);
              }

              try {
                const data = JSON.parse(jsonStr);
                await addContactFromHandshake(data);
              } catch (e) { console.error("Handshake parse error", e); }
              continue;
            }

            if (sender) {
              if (type === "PROFILE_UPDATE") {
                const jsonStr = decrypted.substring("GHOST_SIGNAL:PROFILE_UPDATE:".length);
                try {
                  const updatedData = JSON.parse(jsonStr);
                  // Validate profile update data
                  if (updatedData && typeof updatedData === 'object' &&
                      typeof updatedData.pseudo === 'string' && updatedData.pseudo.length <= 100 &&
                      (!updatedData.avatar || (typeof updatedData.avatar === 'string' && updatedData.avatar.length <= 500000))) {
                    await updateContactInfo(sender.id, updatedData);
                  } else {
                    console.warn("[PROFILE_UPDATE] Invalid profile update data, skipping");
                  }
                } catch (e) { console.error("Profile update parse error", e); }
              }
              else if (type === "DELETE") {
                await deleteContactLocally(sender.id);
              }
              else if (type === "SCREENSHOT") {
                // The contact took a screenshot — save a notification message in history
                const historyKey = `history_${sender.id}`;
                const historyJson = await secureGet(historyKey);
                const history = historyJson ? JSON.parse(historyJson) : [];
                const msgId = `screenshot_${Date.now()}_${Array.from(Crypto.getRandomBytes(4)).map(b => b.toString(16).padStart(2, '0')).join('')}`;
                const screenshotMsg = {
                  id: msgId,
                  text: `📸 ${sender.name || sender.id} a pris une capture d'écran`,
                  timestamp: Date.now(),
                  isMe: false
                };
                await secureSet(historyKey, JSON.stringify([screenshotMsg, ...history]));
              }
              else if (type === "READ") {
                const historyKey = `history_${sender.id}`;
                const historyJson = await secureGet(historyKey);
                if (historyJson) {
                  let history = JSON.parse(historyJson);
                  let changed = false;
                  history = history.map((m: any) => {
                    if (m.isMe && m.status !== 'read') {
                      m.status = 'read';
                      changed = true;
                    }
                    return m;
                  });
                  if (changed) {
                    await secureSet(historyKey, JSON.stringify(history));
                  }
                }
              }
            }
            continue;
          }

          if (!sender) continue;

          // Skip messages from blocked users entirely (don't process/store)
          if (sender.isBlocked) {
            continue;
          }

          if (decrypted.startsWith("GHOST_MEDIA:")) {
            try {
              const parts = decrypted.split(":");
              const mediaType = parts[1];
              const b64 = parts[2];
              const caption = parts[3] || "";

              // Validate media type
              if (mediaType !== 'IMAGE' && mediaType !== 'VIDEO') {
                console.warn("[MEDIA] Invalid media type:", mediaType);
                continue;
              }

              // Validate base64 size (max 10MB decoded)
              if (!b64 || b64.length > 10 * 1024 * 1024 * 1.37) {
                console.warn("[MEDIA] Media too large, skipping");
                continue;
              }

              // Sanitize caption
              const safeCaption = (caption || "").substring(0, 500);
              const ext = mediaType === 'VIDEO' ? 'mp4' : 'jpg';
              const filename = `media_${Date.now()}_${Crypto.getRandomBytes(8).reduce((s: string, b: number) => s + b.toString(16).padStart(2, '0'), '')}.${ext}`;
              const fileUri = (FileSystem.documentDirectory || "") + filename;
              await FileSystem.writeAsStringAsync(fileUri, b64, { encoding: 'base64' });
              decrypted = `GHOST_MEDIA_REF:${mediaType}:${fileUri}:${safeCaption}`;
            } catch (err) {
              console.error("[MEDIA] Failed to save", err);
              continue;
            }
          }

          const historyKey = `history_${sender.id}`;
          const historyJson = await secureGet(historyKey);
          const history = historyJson ? JSON.parse(historyJson) : [];

          // Generate unique message ID using crypto
          const msgIdBytes = Crypto.getRandomBytes(16);
          const msgId = `${Date.now()}_${Array.from(msgIdBytes).map(b => b.toString(16).padStart(2, '0')).join('')}`;

          const newMsg = {
            id: msgId,
            text: decrypted,
            timestamp: Date.now(),
            isMe: false
          };
          await secureSet(historyKey, JSON.stringify([newMsg, ...history]));
        }
      }

      // Acknowledge processed messages
      if (processedIds.length > 0) {
        try {
          await authFetch(`${serverURL}/ack`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messageIds: processedIds })
          });
        } catch (e) {
          console.error("[ACK] Failed to acknowledge messages", e);
        }
      }
    } catch (e) {
      console.error("Global poll error", e);
    }
  };

  const checkGlobalRequests = async () => {
    try {
      const myID = await getMyID();
      if (!myID) return;

      const serverURL = await getServerURL();
      const res = await authFetch(`${serverURL}/friend-requests/${myID}`, { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        await secureSet(CONTACT_REQUESTS_KEY, JSON.stringify(data));
      }
    } catch (e) { }
  };

  const sendHeartbeat = async () => {
    try {
      const os = await SecureStore.getItemAsync("privacy_online_status");
      if (os === "false") return;

      const myID = await getMyID();
      if (!myID) return;

      const serverURL = await getServerURL();
      await authFetch(`${serverURL}/ping`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: myID })
      });
    } catch (e) { }
  };

  const checkContactStatus = async () => {
    try {
      const os = await SecureStore.getItemAsync("privacy_online_status");
      if (os === "false") {
        await AsyncStorage.setItem("contact_presence", JSON.stringify({}));
        return;
      }

      const json = await secureGet(CONTACTS_KEY);
      if (!json) return;
      const contacts = JSON.parse(json);
      const ids = contacts.map((c: any) => c.id);

      if (ids.length === 0) return;

      const serverURL = await getServerURL();
      const res = await authFetch(`${serverURL}/status/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
      });

      if (res.ok) {
        const data = await res.json();
        await AsyncStorage.setItem("contact_presence", JSON.stringify(data));
      }
    } catch (e) { }
  };

  const validateHandshakeData = (data: any): boolean => {
    if (!data || typeof data !== 'object') return false;
    if (typeof data.id !== 'string' || data.id.length !== 12 || !/^[A-F0-9]+$/i.test(data.id)) return false;
    if (typeof data.key !== 'string' || data.key.length !== 64 || !/^[a-f0-9]+$/i.test(data.key)) return false;
    if (data.name && (typeof data.name !== 'string' || data.name.length > 100)) return false;
    // Avatar size limit: max 500KB base64
    if (data.avatar && (typeof data.avatar !== 'string' || data.avatar.length > 500000)) return false;
    return true;
  };

  const addContactFromHandshake = async (data: any) => {
    try {
      // Validate handshake data schema
      if (!validateHandshakeData(data)) {
        console.warn("[HANDSHAKE] Rejected invalid handshake data");
        return;
      }

      const jsonArr = await secureGet(CONTACTS_KEY);
      let list = jsonArr ? JSON.parse(jsonArr) : [];
      const existingIndex = list.findIndex((c: any) => c.id === data.id);

      if (existingIndex !== -1) {
        const existing = list[existingIndex];
        if (existing.key !== data.key) {
          console.warn(`[SECURITY] Key mismatch for ${data.id}!`);
          list[existingIndex] = { ...existing, securityWarning: true, pendingNewKey: data.key };
          await secureSet(CONTACTS_KEY, JSON.stringify(list));
          Alert.alert("Alerte Sécurité", `Le numéro de sécurité de ${data.name} a changé.`);
          return;
        }

        let finalAvatar = data.avatar;
        if (data.avatar && data.avatar.startsWith('data:')) {
          finalAvatar = await saveAvatarLocally(data.id, data.avatar);
        }

        list[existingIndex] = {
          ...existing,
          name: data.name,
          avatar: finalAvatar || existing.avatar
        };
        await secureSet(CONTACTS_KEY, JSON.stringify(list));
        return;
      }

      const finalAvatar = data.avatar && data.avatar.startsWith('data:')
        ? await saveAvatarLocally(data.id, data.avatar)
        : data.avatar;

      list.push({
        id: data.id,
        name: data.name,
        key: data.key,
        avatar: finalAvatar || null,
        isSelf: false
      });
      await secureSet(CONTACTS_KEY, JSON.stringify(list));

      if (Platform.OS === 'web') {
        // Optional: keep console log for debugging
        console.log(`[HANDSHAKE] New contact accepted: ${data.name}`);
      }
    } catch (e) {
      console.error("[HANDSHAKE] Error", e);
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

  const updateContactInfo = async (contactId: string, data: { pseudo: string, avatar: string }) => {
    try {
      const json = await secureGet(CONTACTS_KEY);
      if (!json) return;
      let contacts = JSON.parse(json);
      let changed = false;

      let finalAvatar: string | null = data.avatar;
      if (data.avatar && data.avatar.startsWith('data:')) {
        const local = await saveAvatarLocally(contactId, data.avatar);
        if (local) finalAvatar = local;
      }

      contacts = contacts.map((c: any) => {
        if (c.id === contactId) {
          if (c.name !== data.pseudo || c.avatar !== finalAvatar) {
            changed = true;
            return { ...c, name: data.pseudo, avatar: finalAvatar };
          }
        }
        return c;
      });

      if (changed) {
        await secureSet(CONTACTS_KEY, JSON.stringify(contacts));
      }
    } catch (e) {
      console.error("[PROFILE_SYNC] Failed to update contact", e);
    }
  };


  const deleteContactLocally = async (contactId: string) => {
    try {
      const json = await secureGet(CONTACTS_KEY);
      if (!json) return;
      const list = JSON.parse(json);
      const newList = list.filter((c: any) => c.id !== contactId);
      await secureSet(CONTACTS_KEY, JSON.stringify(newList));

      await secureClear(`last_read_${contactId}`);
      await secureClear(`history_${contactId}`);
    } catch (e) { }
  };

  const updateBadge = async () => {
    try {
      const counts = await getBadgeCounts();
      setMessagesBadge(counts.messages);
      setRequestsBadge(counts.requests);
    } catch (e) { }
  };

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textSecondary,
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarStyle: Platform.select({
          ios: {
            position: 'absolute',
            backgroundColor: isDark ? 'rgba(30,30,30,0.9)' : 'rgba(255,255,255,0.9)',
            borderTopWidth: 0,
            elevation: 0,
            height: 60,
            paddingBottom: 10
          },
          default: {
            backgroundColor: colors.surface,
            borderTopWidth: 0,
            elevation: 0,
            height: 60,
            paddingBottom: 10
          },
        }),
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Chats',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="bubble.left.fill" color={color} />,
          tabBarBadge: messagesBadge > 0 ? messagesBadge : undefined,
        }}
      />
      <Tabs.Screen
        name="contacts"
        options={{
          title: 'Contacts',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="person.2.fill" color={color} />,
          tabBarBadge: requestsBadge > 0 ? requestsBadge : undefined,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Réglages',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="gearshape.fill" color={color} />,
        }}
      />
      <Tabs.Screen name="profile" options={{ href: null }} />
      <Tabs.Screen name="explore" options={{ href: null }} />
    </Tabs>
  );
}
