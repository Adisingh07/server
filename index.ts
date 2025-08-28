
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { MongoClient, ObjectId, Db } from 'mongodb';
import { initializeFirebaseAdmin, adminDb } from './src/firebase-admin';
import type { User, Conversation, Message, MessageRequest } from './src/types';
import dotenv from 'dotenv';
import { APP_ID, SANDBOX } from '../../src/lib/premium-config'; // Keep this path for now as it's shared

dotenv.config();
initializeFirebaseAdmin();

const app = express();
const server = http.createServer(app);

const corsOptions = {
    origin: "http://localhost:9002", // Your Next.js app URL
    methods: ["GET", "POST", "DELETE"]
};

const io = new Server(server, {
  cors: corsOptions
});

app.use(cors(corsOptions));
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/piconnect';
let db: Db;

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


// --- PI PREMIUM & USER API ---

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


app.post("/payments/approve", async (req, res) => {
  const { paymentId, userId } = req.body;
  console.log(`Approving payment ${paymentId} for user ${userId}`);
  try {
    await fetch(`https://${SANDBOX ? "api.sandbox." : ""}pi.network/v2/payments/${paymentId}/approve`, {
        method: "POST",
        headers: { Authorization: `Pi ${process.env.PI_API_KEY}` }
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
        await fetch(`https://${SANDBOX ? "api.sandbox." : ""}pi.network/v2/payments/${paymentId}/complete`, {
            method: "POST",
            headers: { Authorization: `Pi ${process.env.PI_API_KEY}` },
            body: JSON.stringify({ txid }),
        });
        
        const userRef = adminDb.collection('users').doc(userId);
        const userDoc = await userRef.get();
        const userData = userDoc.data();
        
        const now = new Date();
        const currentPremiumUntil = (userData?.premiumUntil && new Date(userData.premiumUntil) > now)
            ? new Date(userData.premiumUntil)
            : now;
        
        const newPremiumUntil = new Date(currentPremiumUntil.getTime() + 30 * 24 * 60 * 60 * 1000);

        await userRef.update({
            premiumUntil: newPremiumUntil.toISOString()
        });

        res.send({ success: true, premiumUntil: newPremiumUntil.toISOString() });
    } catch (e) {
        console.error("Failed to complete payment", e);
        res.status(500).send({ error: (e as Error).message });
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
            lastMessage: null,
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
        
        await db.collection('messageRequests').deleteOne({ _id: new ObjectId(requestId) });

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
      socket.join(userId);
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
      const { conversationId, senderId, receiverId, content } = messageData;

      if (!senderId || (!conversationId && !receiverId)) {
        return callback({ success: false, error: "Missing sender or receiver ID." });
      }

      if (conversationId) {
         if (!content) return callback({ success: false, error: "Message content is empty." });
        const newMessage: Omit<Message, '_id'> = {
          conversationId, senderId, content,
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

      if (!receiverId) return callback({ success: false, error: "Receiver ID is required for new messages." });
      
      const participantIds = [senderId, receiverId].sort();
      let conversation = await db.collection('conversations').findOne({
           participantIds: { $all: participantIds }
      });
      
      if (conversation) {
         return callback({ success: true, conversationId: conversation._id.toHexString() });
      }
      
      let request = await db.collection('messageRequests').findOne({
          $or: [
              { fromId: senderId, toId: receiverId },
              { fromId: receiverId, toId: senderId }
          ]
      });

      if (request) {
          return callback({ success: true, isRequest: true, message: "A message request already exists." });
      }
      
      if (!content) {
          return callback({ success: true, isRequest: false });
      }

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
      
      io.to(receiverId).emit('newMessageRequest');

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
                reactions[reaction] = userIds.filter((id: string) => id !== userId);
            } else {
                Object.keys(reactions).forEach(key => {
                    reactions[key] = reactions[key].filter((id: string) => id !== userId);
                });
                reactions[reaction] = [...(reactions[reaction] || []), userId];
            }
            
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
            if (!message || message.senderId !== userId) return;

            await db.collection('messages').deleteOne({ _id: new ObjectId(messageId) });
            
            io.to(message.conversationId).emit('deleteMessage', messageId);

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
  console.log(`Backend server running on port ${PORT}`);
});
