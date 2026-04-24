

export type User = {
  id: string;
  username: string;
  name: string;
  /** @unique The user's email address. Must be unique across all users. */
  email?: string;
  dob?: string; // Date of Birth
  country?: string;
  password?: string;
  walletPin?: string;
  avatarUrl?: string;
  bannerUrl?: string;
  bio?: string;
  links: string[];
  followers: string[];
  following: string[];
  followersCount?: number;
  followingCount?: number;
  createdAt?: string;
  bookmarks?: string[];
  pinnedPosts?: string[];
  premium?: boolean;
  premiumSince?: string;
  premiumUntil?: string;
  premiumDaysLeft?: number;
  trialUsed?: boolean;
  trialUntil?: string;
  trialDaysLeft?: number;
  blockedUsers?: string[];
  authority?: 'admin' | 'gov' | 'verified' | 'user' | 'bot';
  walletBalance?: number;
  myProductIds?: string[];
  myAppIds?: string[];
  followedApps?: string[];
  referralCode?: string; // User's own referral code (their username)
  referredBy?: string | null; // UID of the user who referred them
  totalReferralPoints?: number;
  postCount?: number;
  totalTippedAmount?: number;
  lastSeen?: string;
  interests?: string[];
  language?: 'en' | 'hi';
  customPushToken?: string;
  customUsername?: string;
  profileCardActive?: boolean;
};

export type DailyActivity = {
  date: string; // YYYY-MM-DD
  timeSpentInMinutes: number;
  lastUpdated?: string; // ISO string
}

export type DailyView = {
  date: string; // YYYY-MM-DD
  viewCount: number;
}


export type ReferralInfo = {
  userId: string;
  username: string;
  joinedAt: string;
  pointsEarned: number;
  tasksCompleted: {
    joined: boolean;       // 5 points
    firstPost: boolean;    // 5 points
    active3Days: boolean;  // 5 points
    active7Days: boolean;  // 10 points
    boughtPremium: boolean;// 25 points
  };
};

export type Post = {
  id: string;
  author: {
    id: string;
    name: string;
    username: string;
    customUsername?: string;
    avatarUrl?: string;
    premium?: boolean;
    authority?: 'admin' | 'gov' | 'verified' | 'user' | 'bot';
  };
  content: string;
  media?: {
    url: string;
    type: 'image' | 'video' | 'gif' | 'audio' | 'pdf' | 'file';
    mimeType?: string;
    fileName?: string;
  }[];
  imageUrl?: string; // Legacy field for single images, often base64
  product?: {
    id: string;
    name: string;
    image: string;
    price: number;
  };
  hashtags?: string[];
  category?: string; // AI-generated category
  hasVideo?: boolean; // Fast filtering for Reels/Videos
  mentions?: string[];
  originalLang?: string; // Detected language code, e.g. "hi", "en"
  translations?: { [langCode: string]: string }; // Cached translations, e.g. { en: "...", hi: "..." }
  translationDone?: boolean; // true once first translation batch is complete
  likes: string[];
  dislikes: string[];
  commentsCount: number;
  viewCount?: number;
  createdAt: string;
  source?: {
    url: string;
    name: string;
  };
  tips?: {
    tipperId: string;
    tipperUsername: string;
    tipperName: string;
    amount: number;
    message?: string;
    createdAt: string;
  }[];
  totalTippedAmount?: number;
};

export type CommunityModerationPost = Post & {
  reports: Report[];
  hideVotes: string[];
  dontHideVotes: string[];
  status: 'under_review' | 'hidden' | 'resolved';
}

export type Comment = {
  id: string;
  postId: string;
  author: {
    id: string;
    name: string;
    username: string;
    customUsername?: string;
    avatarUrl?: string;
    premium?: boolean;
    authority?: 'admin' | 'gov' | 'verified' | 'user' | 'bot';
  };
  content: string;
  likes: string[];
  dislikes: string[];
  createdAt: string;
  parentId?: string | null; // ID of the comment this is a reply to
  replyCount?: number;      // Number of replies to this comment
};

export type AppAnnouncementComment = Omit<Comment, 'postId'> & {
  announcementId: string;
};


export type Report = {
  reporterId: string;
  timestamp: string;
  reason: string;
  details?: string;
};

export type ReportedPost = Post & {
  reports: Report[];
  reporters: string[];
};

export type ReportedUser = User & {
  reports: Report[];
  reporters: string[];
};


export type NotificationActor = {
  id: string;
  name: string;
  username: string;
  avatarUrl?: string;
  actedAt?: Date;
};

export type Notification = {
  _id: string;
  recipientId: string;
  type: 'like' | 'comment' | 'follow' | 'message_request' | 'fund_deposit' | 'withdrawal_approved' | 'withdrawal_cancelled' | 'tip' | 'reply' | 'mention' | 'order_completed' | 'order_cancelled' | 'referral_commission';
  groupKey?: string;
  // Grouped notification fields
  actors?: NotificationActor[];
  actorCount?: number;
  // Legacy single actor (backward compat)
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
  comment?: {
    id: string;
    content: string;
  };
  metadata?: {
    amount?: number;
    reason?: string;
    tipMessage?: string;
  };
  read: boolean;
  createdAt: Date;
  updatedAt?: Date;
}

export type Conversation = {
  _id: string;
  participantIds: string[];
  participants: { [key: string]: User };
  lastMessage: Message | null;
  createdAt: Date;
  updatedAt: Date;
  unreadCount?: number;
}

export type Message = {
  _id: string;
  conversationId: string;
  senderId: string;
  content: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'video';
  createdAt: Date; // Changed to Date type
  readBy: string[];
  reactions: { [emoji: string]: string[] };
  deletedFor: string[];
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

export type PaymentDto = {
  paymentId: string;
  userId: string;
  username: string;
  amount: number;
  memo: string;
  metadata: object;
  toAddress: string;
  createdAt: Date;
}

export type Deposit = {
  paymentId: string;
  userId: string;
  username: string;
  amount: number;
  txid: string;
  createdAt: Date;
}

export type DonationDto = {
  _id?: any; // MongoDB ObjectId
  paymentId: string;
  piUsername: string; // The Pi username of the donor
  amount: number;
  memo: string;
  createdAt: Date;
  campaign?: string | null;
}

export type AIPersona = {
  id: string;
  name: string;
  description: string;
  category: string;
  topics: string[];
  schedule: string;
  authorId: string;
  createdAt: string;
  updatedAt: string;
}

export type Wallet = {
  balance: number;
  username: string;
};

export type TestnetWallet = {
  balance: number;
}

export type ForgotPinRequest = {
  email: string;
  username: string;
  uid: string;
  requestType: string;
  timestamp: Date;
  status: 'pending' | 'resolved';
}

export type Transaction = {
  id: string;
  userId: string;
  username: string;
  type: 'deposit' | 'withdrawal' | 'tip_sent' | 'tip_received' | 'product_purchase' | 'product_sale' | 'creator_reward' | 'paypost_creation_fee' | 'pi_to_cp_conversion' | 'paypost_unlock_fee' | 'paypost_earnings' | 'feature_activation' | 'subscription';
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
    purchaseId?: string;
    receiptId?: string;
    claimId?: string;
    payPostId?: string;
    convertedToCp?: number;
  };
};

export type WithdrawalReceipt = {
  id: string;
  uid: string;
  amount: number;
  fee: number;
  total: number;
  memo: string;
  status: 'processing_creation' | 'processing_submission' | 'processing_completion' | 'completed' | 'failed';
  createdAt: string;
  completedAt?: string;
  paymentId?: string;
  txid?: string;
  piPayment?: any;
  error?: string;
}

export type Broadcast = {
  id: string;
  title: string;
  content: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AccountDeletionRequest = {
  id: string;
  userId: string;
  username: string;
  reason: string;
  requestedAt: Date | string;
  status: 'pending' | 'cancelled' | 'approved';
};

export type GooglePasswordResetRequest = {
  id: string; // email used as ID
  uid: string;
  expiresAt: Date;
}

export type Channel = {
  id: string;
  name: string;
  username: string;
  description: string;
  ownerId: string;
  memberIds: string[];
  createdAt: string;
  iconUrl?: string;
  whoCanPost?: 'owner' | 'members';
  pinnedMessages?: ChannelMessage[];
};

export type ChannelMessage = {
  id: string;
  channelId: string;
  type: 'announcement' | 'poll';
  author: {
    id: string;
    name: string;
    username: string;
    customUsername?: string;
    avatarUrl?: string;
    authority?: string;
    premium?: boolean;
  };
  content: string;
  createdAt: string;
  reactions: { [emoji: string]: string[] }; // Add reactions
  pollOptions?: string[];
  votes?: { [optionIndex: number]: string[] }; // { '0': ['userId1', 'userId2'], '1': ['userId3'] }
  mediaUrl?: string;
  mediaType?: 'image' | 'video';
  parentId?: string | null;
};


export type Review = {
  id: string;
  userId: string;
  username: string;
  userAvatar?: string;
  userName: string;
  rating: number;
  comment: string;
  createdAt: string;
};

export type Product = {
  id: string;
  name: string;
  description: string;
  price: number;
  category: string;
  tags: string[];
  images: string[];
  sellerId: string;
  sellerName: string;
  sellerUsername: string;
  sellerAvatarUrl?: string;
  sellerEmail?: string;
  createdAt: string;
  quantity: number;
  likes: string[];
  dislikes: string[];
  platformFee: number;
  sellerEarnings: number;
  productType: 'virtual' | 'physical';
  deliveryCountries?: string[];
  deliveryEverywhere?: boolean;
  ratingAverage?: number;
  ratingCount?: number;
  appUrl?: string; // Optional URL for virtual products linked to an app
};

export type AffiliateProduct = {
  id: string;
  ownerId: string;
  shortId: string;
  name: string;
  url: string;
  imageUrl: string;
  description: string;
  clicks: number;
  createdAt: string;
};

export type DeliveryDetails = {
  fullName: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export type Purchase = {
  id: string;
  productId: string;
  buyerId: string;
  sellerId: string;
  price: number;
  quantity: number;
  status: 'pending' | 'completed' | 'cancelled';
  createdAt: string;
  acceptedAt?: string;
  completedAt?: string;
  product: {
    id: string;
    name: string;
    images: string[];
  };
  buyer: {
    id: string;
    username: string;
    name: string;
  };
  seller: {
    id: string;
    username: string;
    name: string;
  };
  deliveryDetails?: DeliveryDetails;
  transactionIds?: string[];
};

export type DeveloperApp = {
  id: string;
  name: string;
  tagline: string;
  description: string;
  iconUrl: string;
  gallery: { url: string; type: 'image' | 'video' }[];
  team?: { username: string; role: string }[];
  appUrl: string;
  developerId: string;
  developerName: string;
  developerUsername: string;
  category: string;
  tags: string[];
  followers: string[];
  followersCount: number;
  likes: string[];
  dislikes: string[];
  createdAt: string;
  updatedAt: string;
  announcementsCount?: number;
  averageRating?: number;
  totalRatings?: number;
  visitCount?: number;
};

export type AppRating = {
  appId: string;
  userId: string;
  rating: number; // 1 to 5
  timestamp: string;
};

export type AppAnnouncement = {
  id: string;
  appId: string;
  app: {
    appName: string;
    appIconUrl: string;
  };
  author: {
    id: string;
    name: string;
    username: string;
    customUsername?: string;
    avatarUrl?: string;
    authority?: 'admin' | 'gov' | 'verified' | 'user' | 'bot';
    premium?: boolean;
  };
  content: string;
  createdAt: string;
  likes: string[];
  dislikes: string[];
  commentsCount: number;
  tips?: {
    tipperId: string;
    tipperUsername: string;
    tipperName: string;
    amount: number;
    message?: string;
    createdAt: string;
  }[];
  totalTippedAmount?: number;
};

export type VerificationRequest = {
  id: string;
  userId: string;
  username: string;
  fullName: string;
  contactEmail: string;
  country: string;
  category: string;
  knownAs: string;
  governmentIdType: string;
  governmentIdNumber: string;
  governmentIdFrontUrl: string;
  governmentIdBackUrl: string;
  isGovernmentEntity: boolean;
  isPiCoreTeam: boolean;
  profileLinks: string[];
  notabilityLinks: string[];
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: Date;
  notes?: string; // For admin feedback
}

export type ClaimedPi = {
  id: string; // {userId}_{YYYY-MM-DD}
  userId: string;
  claimDate: string; // YYYY-MM-DD
  viewsClaimed: number;
  piAmount: number;
  status: 'processing' | 'completed';
  createdAt: string; // ISO string
};

export type PayPost = {
  id: string;
  author: {
    id: string;
    name: string;
    username: string;
    customUsername?: string;
    avatarUrl?: string;
  };
  isAnonymous: boolean;
  content?: string;
  media?: { url: string; type: 'image' | 'video' }[];
  price: number; // Stored in subpi
  platformFee: number; // Stored in subpi
  creatorEarnings: number; // Stored in subpi
  unlockedBy: string[]; // List of user IDs who have paid to view
  createdAt: string;
  likes: string[];
  dislikes: string[];
  commentsCount: number;
  isLocked?: boolean;
  thumbnailUrl?: string;
};


export type DraftPayPost = {
  id: string;
  ownerId: string; // The actual user who created the draft
  content: string;
  media: { url: string; type: 'image' | 'video' }[];
  isAnonymous: boolean;
  price: number;
  createdAt: string;
  updatedAt?: string;
  thumbnailUrl?: string;
};

export type Appeal = {
  id: string;
  purchaseId: string;
  productId: string;
  sellerId: string;
  sellerName: string;
  sellerEmail: string;
  details: string;
  deliveryInfo: string;
  attachments: string[];
  status: 'pending' | 'resolved' | 'rejected';
  createdAt: string;
};

export type PasswordResetToken = {
  userId: string;
  email: string;
  token: string;
  expires: string;
};

export type ProfileCard = {
  userId: string;
  username: string;
  customUsername?: string;
  activatedAt: string;
  theme: string;
  contact?: {
    email?: string;
    phone?: string;
  };
  socialLinks?: { type: string, value: string }[];
  customLinks?: { label: string; url: string; iconUrl?: string }[];
  showFollowStats?: boolean;
  showContact?: boolean;
  subscriptionTier?: 'Lite+' | 'Premium Lite' | 'Premium+';
  subscriptionStartDate?: string;
  subscriptionEndDate?: string;
  connectedSubdomain?: string;
  activeEmail?: string;
  visitCount?: number;
  showVisitCount?: boolean;
};

export type DNSRecord = {
  id: string;
  type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS' | 'SRV';
  name: string; // e.g., '@', 'www'
  value: string;
  ttl: number; // in seconds
  priority?: number; // For MX records
};

export type Subdomain = {
  id: string; // the subdomain name itself
  userId: string;
  activeEmail?: string;
  dnsRecords?: DNSRecord[];
  otherDnsInfo?: string;
  dnsLastEdited?: string; // ISO string
};


export type Subscription = {
  id: string;
  userId: string;
  tier: 'Lite+' | 'Premium Lite' | 'Premium+';
  duration: 1 | 3 | 6 | 12;
  amount: number;
  paymentId: string;
  txid: string;
  createdAt: string;
};

export type HeldPayment = {
  id: string; // paymentId
  userId: string;
  tier: 'Lite+' | 'Premium Lite' | 'Premium+';
  duration: number;
  expectedAmount: number;
  actualAmount: number;
  createdAt: string;
  status: 'on-hold' | 'resolved';
}
