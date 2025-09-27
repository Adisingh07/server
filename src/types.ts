



export type User = {
    id: string;
    username: string;
    name: string;
    password?: string; // It's recommended to not store passwords in plain text
    avatarUrl?: string;
    bio?: string;
    links: string[];
    followers: string[]; // Changed to array of user IDs
    following: string[]; // Changed to array of user IDs
    createdAt?: string;
    bookmarks?: string[]; // Array of Post IDs
    pinnedPosts?: string[]; // Array of Post IDs
    premium?: boolean;
    premiumUntil?: string; // ISO Date string for when premium expires
    premiumDaysLeft?: number;
    blockedUsers?: string[]; // Array of user IDs
    authority?: 'admin' | 'gov' | 'moderator' | 'user'; // User roles
  };
  
  export type Post = {
    id: string;
    author: {
      id: string;
      name: string;
      username: string;
      avatarUrl?: string;
      premium?: boolean;
      authority?: 'admin' | 'gov' | 'moderator' | 'user';
    };
    content: string;
    likes: string[]; // User IDs of those who liked
    dislikes: string[]; // User IDs of those who disliked
    commentsCount: number;
    createdAt: string;
  };
  
  export type Comment = {
    id: string;
    postId: string;
    author: {
      id:string;
      name: string;
      username: string;
      avatarUrl?: string;
      premium?: boolean;
      authority?: 'admin' | 'gov' | 'moderator' | 'user';
    };
    content: string;
    likes: string[]; // User IDs
    dislikes: string[]; // User IDs
    createdAt: string;
  };
  
  
  export type Report = {
    reporterId: string;
    timestamp: string;
    reason: string;
    details?: string;
  };
  
  export type ReportedPost = Post & {
    reports: Report[];
    reporters: string[]; // Simple array of reporter UIDs for quick access
  };
  
  export type ReportedUser = User & {
    reports: Report[];
    reporters: string[];
  };
  
  
  export type Notification = {
      _id: string;
      recipientId: string;
      type: 'like' | 'comment' | 'follow' | 'message_request' | 'fund_deposit' | 'withdrawal_approved' | 'withdrawal_cancelled';
      actor: {
          id: string;
          name: string;
          username: string;
          avatarUrl?: string;
      };
      post?: {
          id: string;
          content: string;
      };
       metadata?: {
          amount?: number;
          reason?: string;
      };
      read: boolean;
      createdAt: Date;
  }
  
  export type Conversation = {
      _id: string; // Changed from id to _id for MongoDB
      participantIds: string[];
      participants: { [key: string]: User };
      lastMessage: Message | null;
      createdAt: Date; // Changed to Date type
      updatedAt: Date; // Changed to Date type
  }
  
  export type Message = {
      _id: string; // Changed from id to _id for MongoDB
      conversationId: string;
      senderId: string;
      content: string;
      mediaUrl?: string;
      mediaType?: 'image' | 'video';
      createdAt: Date; // Changed to Date type
      readBy: string[];
      reactions: { [emoji: string]: string[] }; // e.g. { '👍': ['user1', 'user2'] }
      deletedFor: string[]; // Array of user IDs for whom the message is deleted
  }
  
  export type MessageRequest = {
      _id: string;
      fromId: string;
      toId: string;
      fromUser: {
          id: string;
          name: string;
          username: string;
          avatarUrl?: string;
          premium?: boolean;
      };
      initialMessage: {
          content: string;
          createdAt: Date;
      };
      createdAt: Date;
  }
  
  // Data Transfer Object for storing premium payment details
  export type PaymentDto = {
      paymentId: string;
      userId: string;
      username: string;
      amount: number;
      memo: string;
      metadata: object;
      toAddress: string; // The app's receiving address
      createdAt: Date;
  }
  
  // Data Transfer Object for storing donation details
  export type DonationDto = {
      paymentId: string;
      piUsername: string; // The Pi username of the donor
      amount: number;
      memo: string;
      createdAt: Date;
  }
  
  export type Broadcast = {
    id: string;
    title: string;
    content: string;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
  }

  export type Transaction = {
    id: string;
    userId: string;
    username: string;
    type: 'deposit' | 'withdrawal' | 'tip_sent' | 'tip_received';
    status: 'completed' | 'pending' | 'cancelled';
    amount: number;
    reason?: string;
    createdAt: string;
    updatedAt?: string;
    address?: string;
    metadata?: {
      postId?: string;
      fromUserId?: string;
      toUserId?: string;
      tipMessage?: string;
    };
  };

  export type Deposit = {
      paymentId: string;
      userId: string;
      username: string;
      amount: number;
      txid: string;
      createdAt: Date;
  }
