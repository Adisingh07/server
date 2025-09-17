
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { MongoClient, ObjectId, Db } from 'mongodb';
import { initializeFirebaseAdmin, adminDb } from './src/firebase-admin';
import type { User, Conversation, Message, MessageRequest, PaymentDto, DonationDto, Notification, Broadcast, Transaction } from './src/types';
import dotenv from 'dotenv';

dotenv.config();
initializeFirebaseAdmin();

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
    "https://studio-complet2.vercel.app",
    "https://server-bt35.onrender.com",
    "https://connect-pi-roan.vercel.app",
    "https://api.minepi.com",
    "https://connectpi.in"
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


  } catch (error) {
    console.error("MongoDB connection failed:", error);
    process.exit(1);
  }
}

connectDB();


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

async function createNotificationOnServer(notificationData: Omit<Notification, '_id' | 'createdAt' | 'read'>) {
    if (notificationData.recipientId === notificationData.actor.id) {
        return; // Don't notify users of their own actions
    }
    try {
        const fullNotification = {
            ...notificationData,
            createdAt: new Date(),
            read: false,
        };
        const result = await db.collection('notifications').insertOne(fullNotification);
        io.to(notificationData.recipientId).emit('new_notification');
        console.log(`Notification created for ${notificationData.recipientId}`);
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
        res.send({ user: { uid: piUser.uid, username: piUser.username }});
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
  try {
    const payment = req.body; // frontend se aaya hua pending payment
    console.log("Completing payment:", payment);

    if (!payment.identifier) {
      return res.status(400).json({ success: false, error: "Missing payment identifier" });
    }

    // 🔑 Pi API se verify / complete call
    const verifyRes = await fetch(`${PI_API_BASE}/v2/payments/${payment.identifier}/complete`, {
      method: "POST",
      headers: {
        "Authorization": `Key ${process.env.PI_API_KEY}`, // Pi API key env me rakho
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        txid: payment.transaction?.txid || null
      })
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


app.get('/api/notifications/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const notifications = await db.collection('notifications')
            .find({ recipientId: userId })
            .sort({ createdAt: -1 })
            .limit(50)
            .toArray();
        res.status(200).json(notifications);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch notifications.' });
    }
});

app.post('/api/notifications/mark-read', async (req, res) => {
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

app.get('/api/conversations/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const conversations = await db.collection('conversations').find({
            participantIds: userId
        }).sort({ updatedAt: -1 }).toArray();
        res.status(200).json(conversations);
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

app.get('/api/messages/:conversationId', async (req, res) => {
    try {
        const { conversationId } = req.params;
        const messages = await db.collection('messages').find({
            conversationId: conversationId
        }).sort({ createdAt: 1 }).toArray();
        res.status(200).json(messages);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch messages.' });
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
            { $set: { lastMessage: { _id: msgResult.insertedId.toHexString(), ...newMessage }, updatedAt: new Date() }}
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

  socket.on('sendMessage', async (messageData, callback) => {
    try {
      const { conversationId, senderId, receiverId, content, mediaUrl, mediaType } = messageData;

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
        };
        const messageResult = await db.collection('messages').insertOne(newMessage);
        const insertedMessage = { _id: messageResult.insertedId.toHexString(), ...newMessage };

        const updateResult = await db.collection('conversations').findOneAndUpdate(
          { _id: new ObjectId(conversationId) },
          { $set: { lastMessage: insertedMessage, updatedAt: new Date() } },
          { returnDocument: 'after' }
        );

        if (updateResult) {
            io.to(conversationId).emit('receiveMessage', insertedMessage);
            updateResult.participantIds.forEach(id => {
                io.to(id).emit('updateConversation', updateResult);
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

      } catch(error) {
          console.error("Error deleting message:", error);
      }
  });


  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});


const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Chat server running on port ${PORT}`);
});
