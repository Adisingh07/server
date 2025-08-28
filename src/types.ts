export type User = {
  id: string;
  username: string;
  name: string;
  password?: string;
  avatarUrl?: string;
  bio?: string;
  links: string[];
  followers: string[];
  following: string[];
  createdAt?: string;
  bookmarks?: string[];
  pinnedPosts?: string[];
  premium?: boolean;
  premiumUntil?: string; // ISO Date string for when premium expires
  premiumDaysLeft?: number;
};

export type Post = {
  id: string;
  author: {
    id: string;
    name: string;
    username: string;
    avatarUrl?: string;
    premium?: boolean;
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
  };
  content: string;
  likes: string[]; // User IDs
  dislikes: string[]; // User IDs
  createdAt: string;
};


export type Report = {
  reporterId: string;
  timestamp: string;
  reason?: string;
};

export type ReportedPost = Post & {
  reports: Report[];
  reporters: string[]; // Simple array of reporter UIDs for quick access
};


export type Notification = {
    id: string;
    recipientId: string;
    type: 'like' | 'comment' | 'follow';
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
    read: boolean;
    createdAt: string;
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
