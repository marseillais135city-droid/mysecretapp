import AsyncStorage from '@react-native-async-storage/async-storage';
import { secureGet } from './SecureStorage';

const CONTACTS_KEY = "my_contacts_list_v1";
const CONTACT_REQUESTS_KEY = "my_contact_requests_v1";

export const getBadgeCounts = async (): Promise<{ messages: number, requests: number }> => {
    try {
        let messageCount = 0;
        let requestCount = 0;

        // 1. Unread Messages for Chat Tab
        const json = await secureGet(CONTACTS_KEY);
        if (json) {
            const contacts = JSON.parse(json);
            for (const c of contacts) {
                if (c.isSelf) continue;
                const lastReadStr = await AsyncStorage.getItem(`last_read_${c.id}`);
                const lastRead = lastReadStr ? parseInt(lastReadStr) : 0;
                const historyJson = await secureGet(`history_${c.id}`);
                if (historyJson) {
                    const history = JSON.parse(historyJson);
                    for (const msg of history) {
                        const ts = msg.timestamp || parseInt(msg.id);
                        if (!msg.isMe && ts > lastRead) {
                            messageCount++;
                        } else {
                            if (ts <= lastRead) break;
                        }
                    }
                }
            }
        }

        // 2. Pending Requests for Contacts Tab
        const requestsJson = await secureGet(CONTACT_REQUESTS_KEY);
        const requests = requestsJson ? JSON.parse(requestsJson) : [];
        requestCount = requests.length;

        return { messages: messageCount, requests: requestCount };
    } catch (e) {
        return { messages: 0, requests: 0 };
    }
};
