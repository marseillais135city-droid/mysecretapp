import nacl from '@/components/CryptoPolyfill';
import { getGhostStyles } from '@/components/GhostTheme';
import { getServerIP } from '@/constants/Config';
import { useTheme } from '@/context/ThemeContext';
import { getMyID } from '@/utils/AuthHelper';
import { secureGet } from '@/utils/SecureStorage';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { decode as decodeBase64, encode as encodeBase64 } from 'base-64';
import * as Crypto from 'expo-crypto';
import { useFocusEffect, useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Image, Text, TouchableOpacity, View } from 'react-native';

const CONTACTS_KEY = "my_contacts_list_v1";
const STORAGE_KEY = "my_permanent_secret_key_v1";

const stringToUint8Array = (str: string) => { const bytes = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i); return bytes; };
const uint8ArrayToString = (arr: Uint8Array) => { let str = ''; for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]); return str; };
const toHex = (buffer: Uint8Array) => Array.prototype.map.call(new Uint8Array(buffer), x => ('00' + x.toString(16)).slice(-2)).join('');

// PRNG polyfill is handled centrally in CryptoPolyfill.ts

export default function HomeScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => getGhostStyles(colors), [colors]);
  const router = useRouter();
  const [activeChats, setActiveChats] = useState<any[]>([]);
  const [myID, setMyID] = useState("Loading...");

  useFocusEffect(
    useCallback(() => {
      setupIdentity();
      loadActiveChats();

      // Refresh UI from Storage (Data is fetched by _layout.tsx now)
      const interval = setInterval(() => {
        loadActiveChats();
      }, 2000); // Check every 2s for UI updates

      return () => clearInterval(interval);
    }, [myID])
  );

  const setupIdentity = async () => {
    // ... (keep existing setupIdentity)
    console.log("Home: setupIdentity started");
    try {
      let keyPair;
      const stored = await SecureStore.getItemAsync(STORAGE_KEY);

      if (stored) {
        keyPair = nacl.box.keyPair.fromSecretKey(new Uint8Array(stringToUint8Array(decodeBase64(stored))));
      } else {
        keyPair = nacl.box.keyPair();
        await SecureStore.setItemAsync(STORAGE_KEY, encodeBase64(uint8ArrayToString(keyPair.secretKey)));
      }
      const pkHex = toHex(keyPair.publicKey);
      const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, pkHex);
      const id = hash.substring(0, 12).toUpperCase();
      setMyID(id);
    } catch (e) { console.error("Identity setup failed", e); }
  };

  const loadActiveChats = async () => {
    try {
      const serverIP = await getServerIP();
      const json = await secureGet(CONTACTS_KEY);

      if (json) {
        const contacts = JSON.parse(json);
        const active = [];
        let totalUnread = 0;

        for (const c of contacts) {
          if (c.isSelf) continue;

          try {
            const historyKey = `history_${c.id}`;
            const historyJson = await secureGet(historyKey);

            // Get Last Read Time
            const lastReadStr = await AsyncStorage.getItem(`last_read_${c.id}`);
            const lastRead = lastReadStr ? parseInt(lastReadStr) : 0;

            // Load presence locally
            let isOnline = false;
            try {
              const presenceJson = await AsyncStorage.getItem("contact_presence");
              if (presenceJson) {
                const presence = JSON.parse(presenceJson);
                if (presence[c.id]?.isOnline) isOnline = true;
              }
            } catch (e) { }

            let lastMsgData = { text: "Nouvelle conversation", time: "", isMe: false, timestamp: 0 };
            let unreadCount = 0;

            if (historyJson) {
              const history = JSON.parse(historyJson);
              if (history.length > 0) {
                const lastMsg = history[0];
                const ts = lastMsg.timestamp || parseInt(lastMsg.id) || Date.now(); // Fallback to now if missing
                const date = new Date(ts);
                const timeStr = isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

                lastMsgData = {
                  text: lastMsg.text,
                  time: timeStr,
                  isMe: lastMsg.isMe,
                  timestamp: ts
                };

                // Calculate Unread
                for (const msg of history) {
                  const msgTs = msg.timestamp || parseInt(msg.id) || 0;
                  if (!msg.isMe && msgTs > lastRead) {
                    unreadCount++;
                  } else {
                    // Assuming sorted, optimization
                    if (msgTs <= lastRead) break;
                  }
                }

                // Only add to active list if history exists
                active.push({
                  ...c,
                  lastMessage: lastMsgData.text,
                  lastTime: lastMsgData.time,
                  isLastMe: lastMsgData.isMe,
                  unreadCount: unreadCount,
                  timestamp: lastMsgData.timestamp,
                  isOnline: isOnline
                });
              }
            }

            totalUnread += unreadCount;
          } catch (err) {
            console.error(`Error loading chat for ${c.name}:`, err);
          }
        }

        // Sort by time (newest first)
        active.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        // Use functional update to ensure fresh state if needed, though simple set is usually fine here
        setActiveChats(active);

        // Note: Badge is handled by _layout.tsx now (for global), but we calculate unread locally for UI dots.
      }
    } catch (e) { console.error("Error globally loading active chats:", e); }
  };

  const openChat = (contact: any) => {
    router.push({
      pathname: "/chat",
      params: {
        contactId: contact.id,
        contactName: contact.name,
        contactKey: contact.key,
        contactAvatar: contact.avatar
      }
    });
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Chats</Text>
        </View>
        <TouchableOpacity onPress={loadActiveChats}>
          <Text style={{ fontSize: 24, color: colors.primary }}>🔄</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={activeChats}
        keyExtractor={item => item.id}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.card} onPress={() => openChat(item)}>
            <View style={styles.avatarContainer}>
              {item.avatar ? (
                <Image source={{ uri: item.avatar }} style={styles.avatarImage} />
              ) : (
                <Text style={{ fontSize: 24, color: colors.textSecondary }}>👤</Text>
              )}
            </View>
            <View style={{ flex: 1, marginLeft: 15 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Text style={[styles.contactName, item.unreadCount > 0 && { fontWeight: 'bold' }]}>{item.alias || item.name}</Text>
                  {item.isOnline && (
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
                <Text style={{ color: colors.textSecondary, fontSize: 13 }}>{item.lastTime || ""}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={[styles.lastMessage, item.unreadCount > 0 && { color: colors.text, fontWeight: '600' }]} numberOfLines={1}>
                  {item.isLastMe ? "Moi: " : ""}{item.lastMessage || "Nouvelle conversation"}
                </Text>
                {item.unreadCount > 0 && (
                  <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center', marginLeft: 5 }}>
                    <Text style={{ color: 'white', fontSize: 12, fontWeight: 'bold' }}>{item.unreadCount}</Text>
                  </View>
                )}
              </View>
            </View>
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', marginTop: 100 }}>
            <Text style={{ color: colors.textSecondary, textAlign: 'center' }}>
              Aucune conversation récente.
            </Text>
          </View>
        }
      />
    </View>
  );
}