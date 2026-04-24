

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { MongoClient, ObjectId, Db } from 'mongodb';
import { initializeFirebaseAdmin, adminDb } from './src/firebase-admin';
import type { User, Conversation, Message, MessageRequest, PaymentDto, DonationDto, Notification, Broadcast, Transaction, Deposit } from './src/types';
import dotenv from 'dotenv';
import { FieldValue } from 'firebase-admin/firestore';

dotenv.config();
initializeFirebaseAdmin();

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
    "https://studio-complet2.vercel.app",
    "https://server-bt35.onrender.com",
    "https://6000-firebase-studio-1755769384224.cluster-ikxjzjhlifcwuroomfkjrx437g.cloudworkstations.dev",
    "https://connect-pi-roan.vercel.app",
    "https://api.minepi.com",
    "https://connectpi.in",
    "https://*.connectpi.in",
    "http://localhost:9002"
];



const corsOptions = {
    origin: allowedOrigins,
    methods: ["GET", "POST", "DELETE"]
};

const io = new Server(server, {
    cors: corsOptions
});

app.use(cors(corsOptions));
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/piconnect';
let db: Db;

const PI_API_BASE = "https://api.minepi.com";

async function connectDB() {
    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        db = client.db();
        console.log("MongoDB connected successfully");

        await db.collection('conversations').createIndex({ participantIds: 1 });
        await db.collection('conversations').createIndex({ participantIds: 1, updatedAt: -1 });
        await db.collection('messages').createIndex({ conversationId: 1, createdAt: -1 });
        await db.collection('messageRequests').createIndex({ toId: 1 });
        await db.collection('messageRequests').createIndex({ fromId: 1, toId: 1 }, { unique: true });
        await db.collection('payments').createIndex({ userId: 1 });
        await db.collection('payments').createIndex({ paymentId: 1 }, { unique: true });
        await db.collection('donations').createIndex({ piUsername: 1 });
        await db.collection('donations').createIndex({ paymentId: 1 }, { unique: true });
        await db.collection('notifications').createIndex({ recipientId: 1, createdAt: -1 });
        await db.collection('notifications').createIndex({ recipientId: 1, groupKey: 1, read: 1, updatedAt: -1 });
        await db.collection('deposits').createIndex({ userId: 1 });


    } catch (error) {
        console.error("MongoDB connection failed:", error);
        process.exit(1);
    }
}

connectDB();


app.get("/health", (req: express.Request, res: express.Response) => {
    res.status(200).send("ok");
});



async function getUserFromFirestore(userId: string): Promise<User | null> {
    try {
        const doc = await adminDb.collection('users').doc(userId).get();
        if (doc.exists) {
            const data = doc.data();
            const premiumUntil = data?.premiumUntil ? new Date(data.premiumUntil) : null;
            const daysLeft = premiumUntil ? Math.max(0, Math.ceil((premiumUntil.getTime() - Date.now()) / (1000 * 60 * 60 * 24))) : 0;

            return {
                id: doc.id,
                username: data?.username || 'unknown_user',
                name: data?.name || 'Unknown User',
                avatarUrl: data?.avatarUrl,
                premium: daysLeft > 0,
                premiumDaysLeft: daysLeft,
                links: data?.links || [],
                followers: data?.followers || [],
                following: data?.following || [],
            } as User;
        }
        return null;
    } catch (error) {
        console.error(`Failed to fetch user ${userId} from Firestore:`, error);
        return null;
    }
}

async function sendPushNotification(userId: string, title: string, body: string, url: string) {
    try {
        const docRef = adminDb.collection('pushnotification').doc(userId);
        const doc = await docRef.get();
        if (!doc.exists) return;

        const data = doc.data();
        const tokens = data?.customPushToken || [];
        if (tokens.length === 0) return;

        const messages = tokens.map((token: string) => ({
            to: token,
            title,
            body,
            data: { url },
            channelId: 'default'
        }));

        await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(messages),
        });
    } catch (error) {
        console.error(`Failed to send push notification to ${userId}:`, error);
    }
}

async function isUserOnline(userId: string) {
    try {
        const sockets = await io.in(userId).allSockets();
        return sockets.size > 0;
    } catch (error) {
        console.error(`Failed to check online status for ${userId}:`, error);
        return false;
    }
}

// --- WhatsApp-Style Debounce Map ---
// Groups burst messages from the same sender into a single notification
const CHAT_NOTIFICATION_DEBOUNCE_MS = 3000; // 3 seconds window
const pendingChatNotifications = new Map<string, {
    timer: NodeJS.Timeout;
    count: number;
    lastContent: string;
    senderName: string;
    conversationId: string;
    receiverId: string;
    senderId: string;
}>();

/**
 * Fires the actual push notification after the debounce window closes.
 * If multiple messages arrived during the window, shows "X new messages".
 */
async function fireChatPushNotification(key: string) {
    const pending = pendingChatNotifications.get(key);
    if (!pending) return;
    pendingChatNotifications.delete(key);

    const { receiverId, senderId, senderName, lastContent, count, conversationId } = pending;

    try {
        const docRef = adminDb.collection('pushnotification').doc(receiverId);
        const doc = await docRef.get();
        if (!doc.exists) return;

        const data = doc.data();
        const tokens = data?.customPushToken || [];
        if (tokens.length === 0) return;

        // --- Build collapsed body ---
        let body: string;
        if (count === 1) {
            body = lastContent; // Single message: show actual content
        } else {
            body = `📬 ${count} new messages`; // Burst: WhatsApp-style collapse
        }

        // --- collapseId ensures same sender's notifications REPLACE each other on the device ---
        const collapseId = `chat_${senderId}_${receiverId}`;

        const messages = tokens.map((token: string) => ({
            to: token,
            title: senderName,
            body: body,
            data: { type: 'MESSAGE', conversationId },
            channelId: 'urgent',
            sound: 'default',
            _id: collapseId, // Expo collapse key — replaces previous notification from same sender
        }));

        const response = await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(messages),
        });

        const result = await response.json();

        // --- Cleanup Invalid Tokens ---
        if (result.data) {
            const tokensToRemove: string[] = [];
            result.data.forEach((item: any, index: number) => {
                if (item.status === 'error' && item.details?.error === 'DeviceNotRegistered') {
                    tokensToRemove.push(tokens[index]);
                }
            });

            if (tokensToRemove.length > 0) {
                console.log(`Removing ${tokensToRemove.length} inactive tokens for user ${receiverId}`);
                await docRef.update({
                    customPushToken: FieldValue.arrayRemove(...tokensToRemove)
                });
            }
        }

        console.log(`📨 Chat push sent to ${receiverId}: "${body}" (${count} msg${count > 1 ? 's' : ''} collapsed)`);
    } catch (error) {
        console.error('Chat notification delivery failed:', error);
    }
}

async function sendChatPushNotification(receiverId: string, senderId: string, senderName: string, content: string, mediaType: string | null, conversationId: string) {
    try {
        // --- 1. Online Check ---
        if (await isUserOnline(receiverId)) {
            console.log(`Skipping push for ${receiverId}: user is connected via socket`);
            return;
        }

        const docRef = adminDb.collection('pushnotification').doc(receiverId);
        const doc = await docRef.get();
        if (!doc.exists) return;

        const data = doc.data();

        // --- 2. Master Push Switch Check ---
        if (data?.isPushEnabled === false) {
            console.log(`Skipping push for ${receiverId}: push notifications disabled`);
            return;
        }

        // --- 3. Mute Check ---
        const mutedUsers = data?.mutedUsers || [];
        if (mutedUsers.includes(senderId)) {
            console.log(`Notification skipped: User ${receiverId} has muted ${senderId}`);
            return;
        }

        const tokens = data?.customPushToken || [];
        if (tokens.length === 0) return;

        // --- 4. Build content for debounce ---
        let messageBody = content;
        if (!content && mediaType) {
            messageBody = mediaType === 'image' ? 'Sent an image 📷' : 'Sent a video 📹';
        }

        // --- 5. Debounce: Group burst messages ---
        const debounceKey = `${senderId}_${receiverId}`;
        const existing = pendingChatNotifications.get(debounceKey);

        if (existing) {
            // Another message from same sender within the window — update & reset timer
            clearTimeout(existing.timer);
            existing.count += 1;
            existing.lastContent = messageBody;
            existing.conversationId = conversationId;
            existing.timer = setTimeout(() => fireChatPushNotification(debounceKey), CHAT_NOTIFICATION_DEBOUNCE_MS);
        } else {
            // First message — start a new debounce window
            const timer = setTimeout(() => fireChatPushNotification(debounceKey), CHAT_NOTIFICATION_DEBOUNCE_MS);
            pendingChatNotifications.set(debounceKey, {
                timer,
                count: 1,
                lastContent: messageBody,
                senderName,
                conversationId,
                receiverId,
                senderId,
            });
        }
    } catch (error) {
        console.error('Chat notification scheduling failed:', error);
    }
}
// --- Aggregation Constants ---
const AGGREGATABLE_TYPES = ['like', 'comment', 'follow', 'reply', 'mention'];
const AGGREGATION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ACTORS_IN_ARRAY = 5; // Keep latest 5 actors, rest tracked via actorCount

// --- Like/Follow Push Debounce ---
const ACTION_NOTIFICATION_DEBOUNCE_MS = 5000; // 5 second window
const pendingActionNotifications = new Map<string, {
    timer: NodeJS.Timeout;
    count: number;
    latestActorName: string;
    recipientId: string;
    type: string;
    postContent?: string;
    postId?: string;
}>();

async function fireActionPushNotification(key: string) {
    const pending = pendingActionNotifications.get(key);
    if (!pending) return;
    pendingActionNotifications.delete(key);

    const { recipientId, type, latestActorName, count, postContent, postId } = pending;

    let title = '';
    let body = '';
    let url = `${process.env.NEXT_PUBLIC_BASE_URL}/notifications`;

    const othersText = count > 1 ? ` and ${count - 1} other${count > 2 ? 's' : ''}` : '';

    switch (type) {
        case 'like':
            title = `${latestActorName}${othersText} liked your post`;
            body = postContent ? `"${postContent.substring(0, 50)}..."` : '';
            if (postId) url = `${process.env.NEXT_PUBLIC_BASE_URL}/post/${postId}`;
            break;
        case 'follow':
            title = `${latestActorName}${othersText} started following you`;
            body = 'Check out your new followers!';
            break;
        case 'comment':
            title = `${latestActorName}${othersText} commented on your post`;
            body = postContent ? `"${postContent.substring(0, 50)}..."` : '';
            if (postId) url = `${process.env.NEXT_PUBLIC_BASE_URL}/post/${postId}`;
            break;
        case 'reply':
            title = `${latestActorName}${othersText} replied to your comment`;
            body = 'Tap to view the reply.';
            if (postId) url = `${process.env.NEXT_PUBLIC_BASE_URL}/post/${postId}`;
            break;
        case 'mention':
            title = `${latestActorName}${othersText} mentioned you`;
            body = 'You were mentioned in a post.';
            if (postId) url = `${process.env.NEXT_PUBLIC_BASE_URL}/post/${postId}`;
            break;
        default:
            return;
    }

    await sendPushNotification(recipientId, title, body, url);
    console.log(`📨 Action push sent to ${recipientId}: "${title}" (${count} action${count > 1 ? 's' : ''} collapsed)`);
}

function scheduleActionPush(recipientId: string, type: string, actorName: string, postContent?: string, postId?: string) {
    const debounceKey = `${type}_${recipientId}_${postId || 'global'}`;
    const existing = pendingActionNotifications.get(debounceKey);

    if (existing) {
        clearTimeout(existing.timer);
        existing.count += 1;
        existing.latestActorName = actorName;
        existing.timer = setTimeout(() => fireActionPushNotification(debounceKey), ACTION_NOTIFICATION_DEBOUNCE_MS);
    } else {
        const timer = setTimeout(() => fireActionPushNotification(debounceKey), ACTION_NOTIFICATION_DEBOUNCE_MS);
        pendingActionNotifications.set(debounceKey, {
            timer,
            count: 1,
            latestActorName: actorName,
            recipientId,
            type,
            postContent,
            postId,
        });
    }
}

function computeGroupKey(type: string, notificationData: any): string {
    switch (type) {
        case 'like': return `like_${notificationData.post?.id || 'unknown'}`;
        case 'comment': return `comment_${notificationData.post?.id || 'unknown'}`;
        case 'reply': return `reply_${notificationData.comment?.id || notificationData.post?.id || 'unknown'}`;
        case 'mention': return `mention_${notificationData.post?.id || 'unknown'}`;
        case 'follow': return 'follow';
        default: return `${type}_${Date.now()}`; // unique key = no aggregation
    }
}

async function createNotificationOnServer(notificationData: Omit<Notification, '_id' | 'createdAt' | 'read'>) {
    if (notificationData.recipientId === notificationData.actor.id) {
        return; // Don't notify users of their own actions
    }
    try {
        const now = new Date();
        const isAggregatable = AGGREGATABLE_TYPES.includes(notificationData.type);
        const actorEntry = {
            id: notificationData.actor.id,
            name: notificationData.actor.name,
            username: notificationData.actor.username,
            avatarUrl: notificationData.actor.avatarUrl,
            actedAt: now,
        };

        if (isAggregatable) {
            const groupKey = computeGroupKey(notificationData.type, notificationData);
            const windowStart = new Date(now.getTime() - AGGREGATION_WINDOW_MS);

            // Try to find an existing unread group within the time window
            const existingGroup = await db.collection('notifications').findOne({
                recipientId: notificationData.recipientId,
                groupKey: groupKey,
                read: false,
                updatedAt: { $gte: windowStart },
            });

            if (existingGroup) {
                // Check if this actor already exists in the group (prevent duplicate)
                const existingActors = existingGroup.actors || [];
                const actorAlreadyInGroup = existingActors.some((a: any) => a.id === notificationData.actor.id);

                if (actorAlreadyInGroup) {
                    // Just bump the timestamp, don't add duplicate actor
                    await db.collection('notifications').updateOne(
                        { _id: existingGroup._id },
                        { $set: { updatedAt: now } }
                    );
                } else {
                    // Add new actor to front, cap at MAX_ACTORS_IN_ARRAY
                    const updatedActors = [actorEntry, ...existingActors].slice(0, MAX_ACTORS_IN_ARRAY);

                    await db.collection('notifications').updateOne(
                        { _id: existingGroup._id },
                        {
                            $set: {
                                actors: updatedActors,
                                updatedAt: now,
                            },
                            $inc: { actorCount: 1 },
                        }
                    );
                }
            } else {
                // Create new grouped notification
                const groupedNotification = {
                    recipientId: notificationData.recipientId,
                    type: notificationData.type,
                    groupKey: groupKey,
                    actors: [actorEntry],
                    actorCount: 1,
                    // Keep legacy actor field for backward compatibility
                    actor: notificationData.actor,
                    ...(notificationData.post && { post: notificationData.post }),
                    ...(notificationData.comment && { comment: notificationData.comment }),
                    ...(notificationData.metadata && { metadata: notificationData.metadata }),
                    read: false,
                    createdAt: now,
                    updatedAt: now,
                };
                await db.collection('notifications').insertOne(groupedNotification);
            }

            // Schedule debounced push notification for aggregatable types
            scheduleActionPush(
                notificationData.recipientId,
                notificationData.type,
                notificationData.actor.name,
                notificationData.post?.content,
                notificationData.post?.id
            );

        } else {
            // Non-aggregatable: insert as individual notification (with actors array for consistency)
            const fullNotification = {
                recipientId: notificationData.recipientId,
                type: notificationData.type,
                groupKey: `${notificationData.type}_${Date.now()}`,
                actors: [actorEntry],
                actorCount: 1,
                actor: notificationData.actor,
                ...(notificationData.post && { post: notificationData.post }),
                ...(notificationData.comment && { comment: notificationData.comment }),
                ...(notificationData.metadata && { metadata: notificationData.metadata }),
                read: false,
                createdAt: now,
                updatedAt: now,
            };
            await db.collection('notifications').insertOne(fullNotification);

            // Trigger push notification immediately for non-aggregatable types
            if (notificationData.type === 'message_request') {
                await sendPushNotification(
                    notificationData.recipientId,
                    'New Message Request',
                    `You have a new message request from ${notificationData.actor.name}.`,
                    `${process.env.NEXT_PUBLIC_BASE_URL}/messages/requests`
                );
            }
        }

        io.to(notificationData.recipientId).emit('new_notification');
        console.log(`Notification created/updated for ${notificationData.recipientId} [${notificationData.type}]`);

    } catch (error) {
        console.error("Failed to create notification in MongoDB", error);
    }
}


// --- BROADCAST API ---
app.get('/api/broadcast/active', async (req, res) => {
    try {
        const snapshot = await adminDb.collection('broadcasts')
            .where('isActive', '==', true)
            .limit(1)
            .get();

        if (snapshot.empty) {
            return res.status(404).json({ message: 'No active broadcast found.' });
        }

        const broadcast = snapshot.docs[0].data() as Broadcast;
        res.status(200).json(broadcast);

    } catch (error) {
        console.error("Error fetching active broadcast:", error);
        res.status(500).json({ error: 'Failed to fetch active broadcast.' });
    }
});

// --- GET ALL BROADCASTS for user display ---
app.get('/api/broadcasts', async (req, res) => {
    try {
        const snapshot = await adminDb.collection('broadcasts')
            .orderBy('createdAt', 'desc')
            .get();

        if (snapshot.empty) {
            return res.status(200).json([]);
        }

        const broadcasts = snapshot.docs.map(doc => doc.data() as Broadcast);
        res.status(200).json(broadcasts);

    } catch (error) {
        console.error("Error fetching all broadcasts:", error);
        res.status(500).json({ error: 'Failed to fetch broadcasts.' });
    }
});


// --- PI AUTH, PREMIUM & USER API ---

app.post("/auth/verify", async (req, res) => {
    const { accessToken } = req.body;
    if (!accessToken) {
        return res.status(400).send({ message: "Access token is required." });
    }
    try {
        const piApiResponse = await fetch(`${PI_API_BASE}/v2/me`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (!piApiResponse.ok) {
            console.error("Pi API Error:", await piApiResponse.text());
            throw new Error("Failed to verify access token with Pi servers.");
        }

        const piUser = await piApiResponse.json();
        // Return the verified user object from Pi
        res.send({ user: { uid: piUser.uid, username: piUser.username } });
    } catch (e) {
        console.error("Auth verification failed", e);
        res.status(500).send({ message: (e as Error).message });
    }
});



app.get("/user/:uid", async (req, res) => {
    try {
        const user = await getUserFromFirestore(req.params.uid);
        if (!user) {
            return res.status(404).send({ error: "User not found" });
        }
        res.send({ user });
    } catch (e) {
        res.status(500).send({ error: (e as Error).message });
    }
});


// 🔥 Incomplete Payment Handler
app.post("/complete-payment", async (req, res) => {
    const { paymentId, txid, userId } = req.body;
    console.log(`Completing payment ${paymentId} (tx: ${txid}) for user ${userId}`);
    try {
        // Step 1: Complete the payment with the Pi Platform
        const completeResponse = await fetch(`${PI_API_BASE}/v2/payments/${paymentId}/complete`, {
            method: "POST",
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Key ${process.env.PI_API_KEY2}`
            },
            body: JSON.stringify({ txid }),
        });

        if (!verifyRes.ok) {
            const errText = await verifyRes.text();
            console.error("Pi API error:", errText);
            return res.status(500).json({ success: false, error: "Pi API request failed" });
        }

        const verifiedPayment = await verifyRes.json();
        console.log("Payment verified:", verifiedPayment);

        // ✅ DB me save/update karo
        await db.collection("payments").updateOne(
            { paymentId: verifiedPayment.identifier },
            { $set: { ...verifiedPayment, completedAt: new Date() } },
            { upsert: true }
        );

        return res.json({ success: true, payment: verifiedPayment });
    } catch (err) {
        console.error("Error completing payment:", err);
        return res.status(500).json({ success: false, error: "Internal server error" });
    }
});

app.post("/payments/approve", async (req, res) => {
    const { paymentId, userId } = req.body;
    console.log(`Approving payment ${paymentId} for user ${userId}`);
    try {
        // In a real app, you would verify the user making the request
        // and check that the payment is for a valid product.
        await fetch(`${PI_API_BASE}/v2/payments/${paymentId}/approve`, {
            method: "POST",
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Key ${process.env.PI_API_KEY}`
            },
        });
        res.send({ success: true });
    } catch (e) {
        console.error("Failed to approve payment", e);
        res.status(500).send({ error: (e as Error).message });
    }
});


app.post("/payments/complete", async (req, res) => {
    const { paymentId, txid, userId } = req.body;
    console.log(`Completing payment ${paymentId} (tx: ${txid}) for user ${userId}`);
    try {
        // Step 1: Complete the payment with the Pi Platform
        const completeResponse = await fetch(`${PI_API_BASE}/v2/payments/${paymentId}/complete`, {
            method: "POST",
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Key ${process.env.PI_API_KEY}`
            },
            body: JSON.stringify({ txid }),
        });

        if (!completeResponse.ok) {
            const errorText = await completeResponse.text();
            console.error("Failed to complete payment with Pi servers:", errorText);
            throw new Error("Failed to complete payment transaction.");
        }

        const paymentData = await completeResponse.json();

        // Step 2: Grant premium access in Firestore
        const userRef = adminDb.collection('users').doc(userId);
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
            throw new Error("User to grant premium to was not found.");
        }
        const userData = userDoc.data();

        const now = new Date();
        // If user already has premium, extend it. Otherwise, start from now.
        const currentPremiumUntil = (userData?.premiumUntil && new Date(userData.premiumUntil) > now)
            ? new Date(userData.premiumUntil)
            : now;

        const newPremiumUntil = new Date(currentPremiumUntil.getTime() + 30 * 24 * 60 * 60 * 1000);

        await userRef.update({
            premium: true,
            premiumUntil: newPremiumUntil.toISOString()
        });

        // Step 3: Store the payment details (DTO) in MongoDB for records
        const paymentDto: PaymentDto = {
            paymentId: paymentData.identifier,
            userId: userId,
            username: userData?.username,
            amount: paymentData.amount,
            memo: paymentData.memo,
            metadata: paymentData.metadata,
            toAddress: paymentData.to_address,
            createdAt: new Date(paymentData.created_at),
        };
        await db.collection('payments').insertOne(paymentDto);


        res.send({ success: true, premiumUntil: newPremiumUntil.toISOString() });
    } catch (e) {
        console.error("Failed to complete payment", e);
        res.status(500).send({ error: (e as Error).message });
    }
});



app.post("/donate/approve", async (req, res) => {
    const { paymentId } = req.body;
    console.log(`Approving payment ${paymentId}`);
    if (!paymentId) {
        return res.status(400).send({ error: "paymentId is required" });
    }
    try {
        // This endpoint is now generic and doesn't depend on user context.
        await fetch(`${PI_API_BASE}/v2/payments/${paymentId}/approve`, {
            method: "POST",
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Key ${process.env.PI_API_KEY}`
            },
        });
        res.send({ success: true });
    } catch (e) {
        console.error("Failed to approve payment", e);
        res.status(500).send({ error: (e as Error).message });
    }
});

app.post("/donations/complete", async (req, res) => {
    const { paymentId, txid } = req.body;
    console.log(`💰 Completing donation ${paymentId} (tx: ${txid})`);

    try {
        // Step 1: Call Pi API to complete donation
        const completeResponse = await fetch(
            `${PI_API_BASE}/v2/payments/${paymentId}/complete`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Key ${process.env.PI_API_KEY}`,
                },
                body: JSON.stringify({ txid }),
            }
        );

        if (!completeResponse.ok) {
            const errorText = await completeResponse.text();
            console.error("❌ Failed to complete donation with Pi servers:", errorText);
            return res.status(400).json({ success: false, error: errorText });
        }

        const paymentData = await completeResponse.json();

        // Step 2: Prepare donation record safely
        const donationDto: DonationDto = {
            paymentId: paymentData.identifier,
            piUsername: paymentData.from_user?.username || "anonymous",
            amount: paymentData.amount,
            memo: paymentData.memo,
            createdAt: new Date(paymentData.created_at),
        };

        // Step 3: Save in DB
        await db.collection("donations").insertOne(donationDto);

        console.log(`✅ Donation of ${donationDto.amount}π from ${donationDto.piUsername} recorded.`);

        // Step 4: Respond to frontend
        return res.status(200).json({ success: true, donation: donationDto });

    } catch (e) {
        console.error("🔥 Failed to complete donation", e);
        return res.status(500).json({ success: false, error: (e as Error).message });
    }
});






// --- NEW DEPOSIT ENDPOINTS ---
app.post("/payments/approve-deposit", async (req, res) => {
    const { paymentId } = req.body;
    if (!paymentId) {
        return res.status(400).json({ success: false, error: "Missing paymentId" });
    }
    console.log(`Approving deposit payment ${paymentId}`);
    try {
        await fetch(`${PI_API_BASE}/v2/payments/${paymentId}/approve`, {
            method: "POST",
            headers: { 'Authorization': `Key ${process.env.PI_API_KEY}` },
        });
        res.json({ success: true });
    } catch (e) {
        console.error(`Failed to approve deposit payment ${paymentId}:`, e);
        res.status(500).json({ success: false, error: (e as Error).message });
    }
});

app.post("/payments/complete-deposit", async (req, res) => {
    const { paymentId, txid, userId } = req.body;
    if (!paymentId || !txid || !userId) {
        return res.status(400).json({ success: false, error: "Missing required fields." });
    }

    console.log(`Completing deposit ${paymentId} for user ${userId}`);

    try {
        const completeResponse = await fetch(`${PI_API_BASE}/v2/payments/${paymentId}/complete`, {
            method: "POST",
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Key ${process.env.PI_API_KEY}`
            },
            body: JSON.stringify({ txid }),
        });

        if (!completeResponse.ok) {
            const errorText = await completeResponse.text();
            console.error(`Failed to complete deposit with Pi servers:`, errorText);
            throw new Error(`Pi API Error: ${errorText}`);
        }

        const paymentData = await completeResponse.json();
        const amount = paymentData.amount;

        const walletRef = adminDb.collection('wallets').doc(userId);
        const userDoc = await adminDb.collection('users').doc(userId).get();
        if (!userDoc.exists) throw new Error(`User ${userId} not found.`);
        const username = userDoc.data()?.username;

        const newBalance = await adminDb.runTransaction(async (transaction: any) => {
            const walletDoc = await transaction.get(walletRef);

            // Atomically increment the balance
            transaction.set(walletRef, {
                balance: FieldValue.increment(amount),
                username: username
            }, { merge: true });

            // To return the new balance, we must calculate it.
            const currentBalance = walletDoc.exists ? walletDoc.data()?.balance : 0;
            return currentBalance + amount;
        });

        const depositRecord: Deposit = {
            paymentId: paymentData.identifier,
            userId,
            username,
            amount,
            txid,
            createdAt: new Date(paymentData.created_at),
        };
        await db.collection('deposits').insertOne(depositRecord);

        // Record this deposit in the main transactions collection as well for a unified history
        const transactionRecord: Transaction = {
            id: adminDb.collection('transactions').doc().id,
            userId,
            username,
            type: 'deposit',
            status: 'completed',
            amount: amount,
            reason: 'Pi deposit',
            createdAt: new Date(paymentData.created_at).toISOString(),
        };
        await adminDb.collection('transactions').add(transactionRecord);

        await createNotificationOnServer({
            recipientId: userId,
            type: 'fund_deposit',
            actor: { id: 'system', name: 'Connect Pi', username: 'system' },
            metadata: { amount },
        });

        res.status(200).json({ success: true, newBalance });

    } catch (e: any) {
        console.error("Failed to complete deposit:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});


// --- NOTIFICATION API ---


app.post('/api/notifications/create', async (req, res) => {
    try {
        const notification = req.body;
        // Basic validation
        if (!notification.recipientId || !notification.actor || !notification.type) {
            return res.status(400).json({ error: 'Missing required notification fields.' });
        }
        await createNotificationOnServer(notification);
        res.status(201).json({ success: true });
    } catch (error) {
        console.error('Error creating notification via API:', error);
        res.status(500).json({ error: 'Failed to create notification.' });
    }
});


app.get('/api/notifications/:userId', async (req: express.Request, res: express.Response) => {
    try {
        const { userId } = req.params;
        const notifications = await db.collection('notifications')
            .find({ recipientId: userId })
            .sort({ updatedAt: -1, createdAt: -1 })
            .limit(30)
            .toArray();
        res.status(200).json(notifications);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch notifications.' });
    }
});

app.post('/api/notifications/mark-read', async (req: express.Request, res: express.Response) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: 'User ID is required.' });

        await db.collection('notifications').updateMany(
            { recipientId: userId, read: false },
            { $set: { read: true } }
        );
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to mark notifications as read.' });
    }
});

app.post('/api/notifications/register-push', async (req: express.Request, res: express.Response) => {
    try {
        const { userId, token } = req.body;
        if (!userId || !token) {
            return res.status(400).json({ error: 'User ID and token are required.' });
        }

        await adminDb.collection('pushSubscriptions').doc(token).set({
            userId,
            token,
            updatedAt: new Date()
        });

        console.log(`Push token registered for user ${userId}`);
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Error registering push token:', error);
        res.status(500).json({ error: 'Failed to register push token.' });
    }
});

app.get('/api/transactions/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const snapshot = await adminDb.collection('transactions')
            .where('userId', '==', userId)
            .orderBy('createdAt', 'desc')
            .limit(20)
            .get();

        const history = snapshot.docs.map(doc => doc.data() as Transaction);
        res.status(200).json(history);
    } catch (error) {
        console.error("Error fetching transaction history:", error);
        res.status(500).json({ error: 'Failed to fetch transaction history.' });
    }
});

// --- CONVERSATION & MESSAGE API Endpoints ---

app.get('/api/conversations/:userId', async (req: express.Request, res: express.Response) => {
    try {
        const { userId } = req.params;
        const conversations = await db.collection('conversations').find({
            participantIds: userId,
            deletedFor: { $ne: userId } // -- FILTER OUT DELETED FOR ME --
        }).sort({ updatedAt: -1 }).toArray();

        // For each conversation, calculate the unread count
        const conversationsWithUnread = await Promise.all(conversations.map(async (convo: any) => {
            const unreadCount = await db.collection('messages').countDocuments({
                conversationId: convo._id.toHexString(),
                readBy: { $ne: userId },
                deletedFor: { $ne: userId } // -- ALSO FILTER MESSAGES --
            });
            return { ...convo, unreadCount };
        }));

        res.status(200).json(conversationsWithUnread);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch conversations.' });
    }
});

app.get('/api/conversation/:conversationId', async (req, res) => {
    try {
        const { conversationId } = req.params;
        const conversation = await db.collection('conversations').findOne({
            _id: new ObjectId(conversationId)
        });
        if (!conversation) {
            return res.status(404).json({ error: 'Conversation not found.' });
        }
        res.status(200).json(conversation);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch conversation details.' });
    }
});

app.get('/api/messages/:conversationId', async (req: express.Request, res: express.Response) => {
    try {
        const { conversationId } = req.params;
        const userId = req.query.userId as string; // Accept userId for filtering

        const query: any = { conversationId: conversationId };
        if (userId) {
            query.deletedFor = { $ne: userId };
        }

        const messages = await db.collection('messages').find(query).sort({ createdAt: 1 }).toArray();
        res.status(200).json(messages);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch messages.' });
    }
});

app.delete('/api/conversation/:conversationId', async (req: express.Request, res: express.Response) => {
    try {
        const { conversationId } = req.params;
        
        // 1. Delete all messages
        await db.collection('messages').deleteMany({
            conversationId: conversationId
        });
        
        // 2. Delete the conversation
        const result = await db.collection('conversations').deleteOne({
            _id: new ObjectId(conversationId)
        });
        
        if (result.deletedCount === 0) {
            return res.status(404).json({ error: 'Conversation not found.' });
        }
        
        // 3. Notify participants via socket
        io.to(conversationId).emit('conversationDeleted', { conversationId });
        
        res.status(200).json({ success: true, message: 'Conversation deleted successfully.' });
    } catch (error) {
        console.error('Delete conversation error:', error);
        res.status(500).json({ error: 'Failed to delete conversation.' });
    }
});

app.post('/api/conversation/:conversationId/delete-for-me', async (req: express.Request, res: express.Response) => {
    try {
        const { conversationId } = req.params;
        const { userId } = req.body;
        
        if (!userId) return res.status(400).json({ error: 'User ID is required.' });

        // 1. Mark conversation as deleted for user
        await db.collection('conversations').updateOne(
            { _id: new ObjectId(conversationId) },
            { $addToSet: { deletedFor: userId } }
        );

        // 2. Mark all existing messages as deleted for user
        await db.collection('messages').updateMany(
            { conversationId: conversationId },
            { $addToSet: { deletedFor: userId } }
        );

        res.status(200).json({ success: true, message: 'Conversation deleted for you.' });
    } catch (error) {
        console.error('Delete for me error:', error);
        res.status(500).json({ error: 'Failed to delete for you.' });
    }
});


// --- MESSAGE REQUEST API Endpoints ---

app.get('/api/requests/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const requests = await db.collection('messageRequests').find({
            toId: userId
        }).sort({ createdAt: -1 }).toArray();
        res.status(200).json(requests);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch message requests.' });
    }
});

app.delete('/api/requests/:requestId', async (req, res) => {
    try {
        const { requestId } = req.params;
        const result = await db.collection('messageRequests').deleteOne({
            _id: new ObjectId(requestId)
        });
        if (result.deletedCount === 0) {
            return res.status(404).json({ error: 'Request not found.' });
        }
        res.status(200).json({ success: true, message: 'Request deleted.' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete message request.' });
    }
});

app.post('/api/requests/:requestId/accept', async (req, res) => {
    try {
        const { requestId } = req.params;
        const request = await db.collection('messageRequests').findOne({
            _id: new ObjectId(requestId)
        });

        if (!request) {
            return res.status(404).json({ error: 'Message request not found.' });
        }

        const { fromId, toId, initialMessage } = request;
        const participantIds = [fromId, toId].sort();

        // Create new conversation
        const [user1, user2] = await Promise.all([
            getUserFromFirestore(fromId),
            getUserFromFirestore(toId)
        ]);

        if (!user1 || !user2) {
            return res.status(404).json({ error: 'One or both users not found.' });
        }

        const newConversation: Omit<Conversation, '_id'> = {
            participantIds,
            participants: { [fromId]: user1, [toId]: user2 },
            lastMessage: null, // The first message will be added right after
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        const convoResult = await db.collection('conversations').insertOne(newConversation);
        const conversationId = convoResult.insertedId.toHexString();

        // Add the initial message to the new conversation
        const newMessage: Omit<Message, '_id'> = {
            conversationId,
            senderId: fromId,
            content: initialMessage.content,
            createdAt: initialMessage.createdAt,
            readBy: [],
            reactions: {},
            deletedFor: [],
        };
        const msgResult = await db.collection('messages').insertOne(newMessage);

        // Update the new conversation with this first message as the lastMessage
        await db.collection('conversations').updateOne(
            { _id: convoResult.insertedId },
            { $set: { lastMessage: { _id: msgResult.insertedId.toHexString(), ...newMessage }, updatedAt: new Date() } }
        );

        // Finally, delete the request
        await db.collection('messageRequests').deleteOne({ _id: new ObjectId(requestId) });

        // Notify both users that a new conversation has started
        const finalConversation = await db.collection('conversations').findOne({ _id: convoResult.insertedId });
        participantIds.forEach(id => {
            io.to(id).emit('newConversation', finalConversation);
        });

        res.status(201).json({ success: true, conversationId });

    } catch (error) {
        console.error("Error accepting request:", error);
        res.status(500).json({ error: 'Server error while accepting request.' });
    }
});


// --- Socket.IO Logic ---
io.on('connection', (socket) => {
    const userId = socket.handshake.query.userId as string;
    if (userId) {
        console.log(`User connected: ${userId}, socket: ${socket.id}`);
        socket.join(userId); // User joins a room for their own notifications
    }

    socket.on('joinRoom', (conversationId) => {
        socket.join(conversationId);
        console.log(`Socket ${socket.id} joined room ${conversationId}`);
    });

    socket.on('leaveRoom', (conversationId) => {
        socket.leave(conversationId);
        console.log(`Socket ${socket.id} left room ${conversationId}`);
    });

    socket.on('findOrCreateConversation', async (data, callback) => {
        const { senderId, receiverId } = data;
        if (!senderId || !receiverId) {
            return callback({ success: false, error: 'Sender and receiver IDs are required.' });
        }

        try {
            const participantIds = [senderId, receiverId].sort();
            let conversation = await db.collection('conversations').findOne({
                participantIds: { $all: participantIds }
            });

            if (conversation) {
                return callback({ success: true, conversationId: conversation._id.toHexString() });
            }

            // Create new conversation if it doesn't exist
            const [user1, user2] = await Promise.all([
                getUserFromFirestore(senderId),
                getUserFromFirestore(receiverId)
            ]);

            if (!user1 || !user2) {
                return callback({ success: false, error: 'One or both users not found.' });
            }

            const newConversationData: Omit<Conversation, '_id'> = {
                participantIds,
                participants: { [senderId]: user1, [receiverId]: user2 },
                lastMessage: null,
                createdAt: new Date(),
                updatedAt: new Date(),
            };

            const result = await db.collection('conversations').insertOne(newConversationData);
            const newConversationId = result.insertedId.toHexString();

            const finalConversation = await db.collection('conversations').findOne({ _id: result.insertedId });

            // Notify both users that a new conversation has been created
            participantIds.forEach(id => {
                io.to(id).emit('newConversation', finalConversation);
            });

            callback({ success: true, conversationId: newConversationId });

        } catch (error) {
            console.error('Error in findOrCreateConversation:', error);
            callback({ success: false, error: 'Server error while finding or creating conversation.' });
        }
    });

    socket.on('sendMessage', async (messageData, callback) => {
        try {
            const { conversationId, senderId, receiverId, content, mediaUrl, mediaType, replyTo } = messageData;

            if (!senderId || (!conversationId && !receiverId)) {
                return callback({ success: false, error: "Missing sender or receiver ID." });
            }

            // --- SCENARIO 1: Sending message in an EXISTING conversation ---
            if (conversationId) {
                if (!content && !mediaUrl) return callback({ success: false, error: "Message content or media is empty." });
                const newMessage: Omit<Message, '_id'> = {
                    conversationId, senderId, content, mediaUrl, mediaType,
                    createdAt: new Date(), readBy: [senderId],
                    reactions: {}, deletedFor: [],
                    replyTo: replyTo || null,
                };
                const messageResult = await db.collection('messages').insertOne(newMessage);
                const insertedMessage = { _id: messageResult.insertedId.toHexString(), ...newMessage };

                const updateResult = await db.collection('conversations').findOneAndUpdate(
                    { _id: new ObjectId(conversationId) },
                    { 
                        $set: { 
                            lastMessage: insertedMessage, 
                            updatedAt: new Date(),
                            deletedFor: [] // -- CLEAR DELETED FOR ME STATE --
                        } 
                    },
                    { returnDocument: 'after' }
                );

                if (updateResult) {
                    io.to(conversationId).emit('receiveMessage', insertedMessage);
                    updateResult.participantIds.forEach(id => {
                        io.to(id).emit('updateConversation', updateResult);
                        // Send push notification to the other user
                        if (id !== senderId) {
                            sendChatPushNotification(
                                id,
                                senderId,
                                updateResult.participants[senderId].name,
                                content || '',
                                mediaType,
                                conversationId
                            );
                        }
                    });
                }
                return callback({ success: true });
            }

            // --- SCENARIO 2: Sending a NEW message (check for existing convo or request) ---
            if (!receiverId) return callback({ success: false, error: "Receiver ID is required for new messages." });

            const participantIds = [senderId, receiverId].sort();
            let conversation = await db.collection('conversations').findOne({
                participantIds: { $all: participantIds }
            });

            // If conversation already exists, just return its ID.
            if (conversation) {
                return callback({ success: true, conversationId: conversation._id.toHexString() });
            }

            // Check if a request already exists (either way)
            let request = await db.collection('messageRequests').findOne({
                $or: [
                    { fromId: senderId, toId: receiverId },
                    { fromId: receiverId, toId: senderId }
                ]
            });

            if (request) {
                return callback({ success: true, isRequest: true, message: "A message request already exists." });
            }

            // If no message content, it was just a check. Don't create a request.
            if (!content && !mediaUrl) {
                return callback({ success: true, isRequest: false });
            }

            // Create a new Message Request
            const fromUser = await getUserFromFirestore(senderId);
            if (!fromUser) return callback({ success: false, error: 'Sender not found.' });

            const newRequest: Omit<MessageRequest, '_id'> = {
                fromId: senderId,
                toId: receiverId,
                fromUser: {
                    id: fromUser.id,
                    username: fromUser.username,
                    name: fromUser.name,
                    avatarUrl: fromUser.avatarUrl,
                    premium: fromUser.premium || false,
                },
                initialMessage: {
                    content,
                    createdAt: new Date(),
                },
                createdAt: new Date(),
            };

            await db.collection('messageRequests').insertOne(newRequest);

            // Create a notification for the message request
            await createNotificationOnServer({
                recipientId: receiverId,
                actor: { id: fromUser.id, name: fromUser.name, username: fromUser.username, avatarUrl: fromUser.avatarUrl },
                type: 'message_request'
            });

            callback({ success: true, isRequest: true });

        } catch (error) {
            console.error('Error sending message:', error);
            callback({ success: false, error: 'Failed to send message.' });
        }
    });

    socket.on('typing', ({ conversationId, isTyping }) => {
        socket.to(conversationId).emit('typing', { isTyping });
    });

    socket.on('markAsRead', async ({ conversationId, userId }) => {
        try {
            const updateResult = await db.collection('messages').updateMany(
                { conversationId: conversationId, readBy: { $ne: userId } },
                { $addToSet: { readBy: userId } }
            );

            if (updateResult.modifiedCount > 0) {
                // Notify the room that messages have been read
                io.to(conversationId).emit('messagesRead', { conversationId, readerId: userId });
            }
        } catch (error) {
            console.error('Error marking messages as read:', error);
        }
    });

    socket.on('reactToMessage', async ({ messageId, userId, reaction }) => {
        try {
            const message = await db.collection('messages').findOne({ _id: new ObjectId(messageId) });
            if (!message) return;

            const reactions = message.reactions || {};
            const userIds = reactions[reaction] || [];

            if (userIds.includes(userId)) {
                // User is removing their reaction
                reactions[reaction] = userIds.filter((id: string) => id !== userId);
            } else {
                // User is adding a reaction, remove from any other reaction they might have had
                Object.keys(reactions).forEach(key => {
                    reactions[key] = reactions[key].filter((id: string) => id !== userId);
                });
                reactions[reaction] = [...(reactions[reaction] || []), userId];
            }

            // Clean up empty reaction arrays
            Object.keys(reactions).forEach(key => {
                if (reactions[key].length === 0) {
                    delete reactions[key];
                }
            });

            const updateResult = await db.collection('messages').findOneAndUpdate(
                { _id: new ObjectId(messageId) },
                { $set: { reactions } },
                { returnDocument: 'after' }
            );

            if (updateResult) {
                io.to(message.conversationId).emit('updateMessage', updateResult);
            }

        } catch (error) {
            console.error('Error reacting to message:', error);
        }
    });

    socket.on('deleteMessage', async ({ messageId, userId }) => {
        try {
            const message = await db.collection('messages').findOne({ _id: new ObjectId(messageId) });
            if (!message || message.senderId !== userId) return; // Only sender can delete

            await db.collection('messages').deleteOne({ _id: new ObjectId(messageId) });

            io.to(message.conversationId).emit('deleteMessage', messageId);

            // If it was the last message, update the conversation's lastMessage
            const conversation = await db.collection('conversations').findOne({ _id: new ObjectId(message.conversationId) });
            if (conversation?.lastMessage?._id === messageId) {
                const newLastMessage = await db.collection('messages')
                    .find({ conversationId: message.conversationId })
                    .sort({ createdAt: -1 })
                    .limit(1)
                    .next();

                await db.collection('conversations').updateOne(
                    { _id: new ObjectId(message.conversationId) },
                    { $set: { lastMessage: newLastMessage, updatedAt: newLastMessage?.createdAt || new Date() } }
                );

                const updatedConversation = await db.collection('conversations').findOne({ _id: new ObjectId(message.conversationId) });
                if (updatedConversation) {
                    updatedConversation.participantIds.forEach(id => {
                        io.to(id).emit('updateConversation', updatedConversation);
                    });
                }
            }

        } catch (error) {
            console.error("Error deleting message:", error);
        }
    });

    socket.on('deleteMessageForMe', async ({ messageId, userId }: { messageId: string, userId: string }) => {
        try {
            await db.collection('messages').updateOne(
                { _id: new ObjectId(messageId) },
                { $addToSet: { deletedFor: userId } }
            );
            // No need to emit to room, as it's only for this user
        } catch (error) {
            console.error("Error hiding message for me:", error);
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
    });
});


// --- Notification Cleanup Cron Job ---
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // Every 24 hours
const NOTIFICATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function cleanupOldNotifications() {
    try {
        const cutoffDate = new Date(Date.now() - NOTIFICATION_MAX_AGE_MS);
        const result = await db.collection('notifications').deleteMany({
            read: true,
            createdAt: { $lt: cutoffDate },
        });
        if (result.deletedCount > 0) {
            console.log(`🧹 Cleanup: Deleted ${result.deletedCount} old read notifications (older than 30 days)`);
        }
    } catch (error) {
        console.error('Notification cleanup failed:', error);
    }
}

// Run cleanup on startup (after a short delay to ensure DB is connected) and then every 6 hours
setTimeout(() => {
    cleanupOldNotifications();
    setInterval(cleanupOldNotifications, CLEANUP_INTERVAL_MS);
    console.log('🕐 Notification cleanup cron started (every 6 hours, deletes 30-day old read notifications)');
}, 10000);


const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Chat server running on port ${PORT}`);
});
