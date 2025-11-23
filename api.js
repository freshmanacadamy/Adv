const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');

// Simple Firebase Setup
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
    }),
  });
}

const db = admin.firestore();
console.log('✅ Firebase connected successfully');

// 🛡️ GLOBAL ERROR HANDLER
process.on('unhandledRejection', (error) => {
  console.error('🔴 Unhandled Promise Rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('🔴 Uncaught Exception:', error);
});

// Get environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(Number) : [];
const BOT_USERNAME = process.env.BOT_USERNAME;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN environment variable is required');
}

if (!CHANNEL_ID) {
  console.error('❌ CHANNEL_ID environment variable is required');
}

if (!BOT_USERNAME) {
  console.error('❌ BOT_USERNAME environment variable is required');
}

// Create bot instance (without polling)
const bot = new TelegramBot(BOT_TOKEN);

// ========== DATABASE FUNCTIONS ========== //
async function getUser(userId) {
  const userDoc = await db.collection('users').doc(userId.toString()).get();
  if (!userDoc.exists) {
    const newUser = {
      telegramId: userId,
      username: null,
      firstName: null,
      joinedAt: new Date().toISOString(),
      reputation: 0,
      dailyStreak: 0,
      lastCheckin: null,
      totalConfessions: 0,
      followers: [],
      following: [],
      achievements: [],
      bio: null,
      isActive: true,
      notifications: {
        newFollower: true,
        newComment: true,
        newConfession: true,
        directMessage: true
      },
      commentSettings: {
        allowComments: 'everyone',
        allowAnonymous: true,
        requireApproval: false
      }
    };
    await db.collection('users').doc(userId.toString()).set(newUser);
    return newUser;
  }
  return userDoc.data();
}

async function updateUser(userId, updateData) {
  await db.collection('users').doc(userId.toString()).update(updateData);
}

async function getConfession(confessionId) {
  const confDoc = await db.collection('confessions').doc(confessionId).get();
  return confDoc.exists ? confDoc.data() : null;
}

async function createConfession(confessionData) {
  await db.collection('confessions').doc(confessionData.confessionId).set(confessionData);
}

async function updateConfession(confessionId, updateData) {
  await db.collection('confessions').doc(confessionId).update(updateData);
}

async function getComment(confessionId) {
  const commentDoc = await db.collection('comments').doc(confessionId).get();
  return commentDoc.exists ? commentDoc.data() : { comments: [], totalComments: 0 };
}

async function updateComment(confessionId, commentData) {
  await db.collection('comments').doc(confessionId).set(commentData);
}

async function getCounter(counterName) {
  const counterDoc = await db.collection('counters').doc(counterName).get();
  if (!counterDoc.exists) {
    await db.collection('counters').doc(counterName).set({ value: 1 });
    return 1;
  }
  return counterDoc.data().value;
}

async function incrementCounter(counterName) {
  const counterRef = db.collection('counters').doc(counterName);
  const result = await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(counterRef);
    const newValue = doc.exists ? doc.data().value + 1 : 1;
    transaction.update(counterRef, { value: newValue });
    return newValue;
  });
  return result;
}

// ========== UTILITY FUNCTIONS ========== //
function sanitizeInput(text) {
  if (!text) return '';
  
  let sanitized = text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+="[^"]*"/gi, '')
    .replace(/<[^>]*>/g, '')
    .trim();
  
  return sanitized;
}

function extractHashtags(text) {
  const hashtagRegex = /#[a-zA-Z0-9_]+/g;
  return text.match(hashtagRegex) || [];
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

function getUserLevel(commentCount) {
  if (commentCount >= 1000) return { level: 7, symbol: '👑', name: 'Level 7' };
  if (commentCount >= 500) return { level: 6, symbol: '🏅', name: 'Level 6' };
  if (commentCount >= 200) return { level: 5, symbol: '🥇', name: 'Level 5' };
  if (commentCount >= 100) return { level: 4, symbol: '🥈', name: 'Level 4' };
  if (commentCount >= 50) return { level: 3, symbol: '🥉', name: 'Level 3' };
  if (commentCount >= 25) return { level: 2, symbol: '🥈', name: 'Level 2' };
  return { level: 1, symbol: '🥉', name: 'Level 1' };
}

async function getCommentCount(userId) {
  let count = 0;
  const commentsSnapshot = await db.collection('comments').get();
  
  commentsSnapshot.forEach(doc => {
    const data = doc.data();
    if (data.comments) {
      for (const comment of data.comments) {
        if (comment.userId === userId) {
          count++;
        }
      }
    }
  });
  
  return count;
}

// ========== COOLDOWN SYSTEM ========== //
async function checkCooldown(userId, action = 'confession', cooldownMs = 60000) {
  const cooldownDoc = await db.collection('cooldowns').doc(userId.toString()).get();
  if (!cooldownDoc.exists) return true;
  
  const data = cooldownDoc.data();
  const lastAction = data[action];
  
  if (!lastAction) return true;
  
  return (Date.now() - lastAction) > cooldownMs;
}

async function setCooldown(userId, action = 'confession') {
  await db.collection('cooldowns').doc(userId.toString()).set({
    [action]: Date.now()
  }, { merge: true });
}

async function checkCommentRateLimit(userId, windowMs = 30000, maxComments = 3) {
  const rateLimitDoc = await db.collection('rate_limits').doc(userId.toString()).get();
  if (!rateLimitDoc.exists) return true;
  
  const data = rateLimitDoc.data();
  const recentComments = data.commentTimestamps || [];
  
  const now = Date.now();
  const recent = recentComments.filter(ts => (now - ts) <= windowMs);
  
  return recent.length < maxComments;
}

async function recordComment(userId) {
  const now = Date.now();
  await db.collection('rate_limits').doc(userId.toString()).update({
    commentTimestamps: admin.firestore.FieldValue.arrayUnion(now)
  });
}

// ========== STATE MANAGEMENT ========== //
const userStates = new Map();

// ========== MAIN MENU (With Promotion Buttons) ========== //
const showMainMenu = async (chatId) => {
  const user = await getUser(chatId);
  const reputation = user.reputation || 0;
  const streak = user.dailyStreak || 0;
  const commentCount = await getCommentCount(chatId);
  const levelInfo = getUserLevel(commentCount);

  const options = {
    reply_markup: {
      keyboard: [
        [{ text: '📝 Send Confession' }, { text: '👤 My Profile' }],
        [{ text: '🔥 Trending' }, { text: '📢 Promote Bot' }], // Replaced Daily Check-in
        [{ text: '🏷️ Hashtags' }, { text: '🏆 Best Commenters' }],
        [{ text: '⚙️ Settings' }, { text: 'ℹ️ About Us' }],
        [{ text: '🔍 Browse Users' }, { text: '📌 Rules' }]
      ],
      resize_keyboard: true
    }
  };

  await bot.sendMessage(chatId,
    `🤫 *JU Confession Bot*\n\n` +
    `👤 Profile: ${user.username ? `$${user.username}` : 'Not set'}\n` +
    `⭐ Reputation: ${reputation}\n` +
    `🔥 Streak: ${streak} days\n` +
    `🏆 Level: ${levelInfo.symbol} ${levelInfo.name} (${commentCount} comments)\n\n` +
    `Choose an option below:`,
    { parse_mode: 'Markdown', ...options }
  );
};

// ========== START COMMAND (With Username Setup) ========== //
const handleStart = async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const args = msg.text.split(' ')[1];

  // Handle comment redirection
  if (args && args.startsWith('comments_')) {
    const confessionId = args.replace('comments_', '');
    await handleViewComments(chatId, confessionId);
    return;
  }

  // Get or create user
  const user = await getUser(userId);
  
  if (!user.isActive) {
    await bot.sendMessage(chatId, '❌ Your account has been blocked by admin.');
    return;
  }

  // If user doesn't have a username, prompt them to set one
  if (!user.username) {
    await bot.sendMessage(chatId,
      `🤫 *Welcome to JU Confession Bot!*\n\n` +
      `First, please set your username (without $ symbol):\n\n` +
      `Enter your desired username (3-20 characters, letters/numbers/underscores only):`
    );
    
    userStates.set(userId, {
      state: 'awaiting_username',
      originalChatId: chatId
    });
    return;
  }

  await bot.sendMessage(chatId,
    `🤫 *Welcome back, $${user.username}!*\n\n` +
    `Send me your confession and it will be submitted anonymously for admin approval.\n\n` +
    `Your identity will never be revealed!`,
    { parse_mode: 'Markdown' }
  );

  await showMainMenu(chatId);
};

// ========== PROMOTE BOT ========== //
const handlePromoteBot = async (msg) => {
  const chatId = msg.chat.id;
  
  await bot.sendMessage(chatId,
    `📢 *Help Us Grow!*\n\n` +
    `Share our bot with friends:\n` +
    `https://t.me/${BOT_USERNAME}\n\n` +
    `Promotion buttons:\n` +
    `• [Share with Friends](https://t.me/share/url?url=https://t.me/${BOT_USERNAME}&text=Check%20out%20this%20anonymous%20confession%20bot!)\n` +
    `• [Join Channel](https://t.me/juconfessions)\n` +
    `• [Rate Us](https://t.me/${BOT_USERNAME})`,
    { 
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { 
              text: '📤 Share Bot', 
              url: `https://t.me/share/url?url=https://t.me/${BOT_USERNAME}&text=Check%20out%20this%20anonymous%20confession%20bot!`
            }
          ],
          [
            { 
              text: '📢 Join Channel', 
              url: CHANNEL_ID.startsWith('@') ? `https://t.me/${CHANNEL_ID.slice(1)}` : `https://t.me/juconfessions`
            }
          ],
          [
            { 
              text: '⭐ Rate Bot', 
              url: `https://t.me/${BOT_USERNAME}`
            }
          ],
          [
            { text: '🔙 Back to Menu', callback_ 'back_to_menu' }
          ]
        ]
      }
    }
  );
};

// ========== DAILY CHECKIN (Now Promotion) ========== //
const handleCheckin = async (msg) => {
  // This function is now replaced by promotion
  await handlePromoteBot(msg);
};

// ========== SEND CONFESSION ========== //
const handleSendConfession = async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const user = await getUser(userId);

  if (!user.isActive) {
    await bot.sendMessage(chatId, '❌ Your account has been blocked by admin.');
    return;
  }

  // Check cooldown
  const canSubmit = await checkCooldown(userId, 'confession', 60000);
  if (!canSubmit) {
    const cooldownDoc = await db.collection('cooldowns').doc(userId.toString()).get();
    if (cooldownDoc.exists) {
      const data = cooldownDoc.data();
      const lastSubmit = data.confession || 0;
      const waitTime = Math.ceil((60000 - (Date.now() - lastSubmit)) / 1000);
      await bot.sendMessage(chatId, `Please wait ${waitTime} seconds before submitting another confession.`);
      return;
    }
  }

  userStates.set(userId, {
    state: 'awaiting_confession',
    confessionData: {}
  });

  await bot.sendMessage(chatId,
    `✍️ *Send Your Confession*\n\nType your confession below (max 1000 characters):\n\nYou can add hashtags like #love #study #funny`,
    { parse_mode: 'Markdown' }
  );
};

// ========== VIEW PROFILE ========== //
const handleMyProfile = async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const user = await getUser(userId);

  const commentCount = await getCommentCount(userId);
  const levelInfo = getUserLevel(commentCount);

  const profileText = `👤 *My Profile*\n\n`;
  // Fixed: Show the actual username from database
  const username = user.username ? `**Username:** $${user.username}\n` : `**Username:** Not set\n`;
  const level = `**Level:** ${levelInfo.symbol} ${levelInfo.name} (${commentCount} comments)\n`;
  const bio = user.bio ? `**Bio:** ${user.bio}\n` : `**Bio:** Not set\n`;
  const followers = `**Followers:** ${user.followers?.length || 0}\n`;
  const following = `**Following:** ${user.following?.length || 0}\n`;
  const confessions = `**Total Confessions:** ${user.totalConfessions || 0}\n`;
  const reputation = `**Reputation:** ${user.reputation || 0}\n`;
  const achievements = `**Achievements:** ${user.achievements?.length || 0}\n`;
  const streak = `**Daily Streak:** ${user.dailyStreak || 0} days\n`;
  const joinDate = `**Member Since:** ${new Date(user.joinedAt).toLocaleDateString()}\n`;

  const fullText = profileText + username + level + bio + followers + following + confessions + reputation + achievements + streak + joinDate;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📝 Set Username', callback_data: 'set_username' },
          { text: '📝 Set Bio', callback_ 'set_bio' }
        ],
        [
          { text: '🔒 Comment Settings', callback_ 'comment_settings' },
          { text: '📝 My Confessions', callback_ 'my_confessions' }
        ],
        [
          { text: '👥 Followers', callback_data: 'show_followers' },
          { text: '👥 Following', callback_ 'show_following' }
        ],
        [
          { text: '🏆 View Achievements', callback_ 'view_achievements' },
          { text: '🏆 View Rankings', callback_ 'view_rankings' }
        ],
        [
          { text: '🔍 Browse Users', callback_data: 'browse_users' },
          { text: '🔙 Back to Menu', callback_ 'back_to_menu' }
        ]
      ]
    }
  };

  await bot.sendMessage(chatId, fullText, { 
    parse_mode: 'Markdown',
    ...keyboard
  });
};

// ========== MY CONFESSIONS ========== //
const handleMyConfessions = async (chatId, userId) => {
  const user = await getUser(userId);

  // Find user's confessions
  const confessionsSnapshot = await db.collection('confessions')
    .where('userId', '==', userId)
    .orderBy('createdAt', 'desc')
    .get();

  if (confessionsSnapshot.empty) {
    await bot.sendMessage(chatId, 
      `📝 *My Confessions*\n\nYou haven't submitted any confessions yet.`
    );
    return;
  }

  let confessionsText = `📝 *My Confessions*\n\n`;

  const confessionsList = [];
  confessionsSnapshot.forEach(doc => {
    confessionsList.push(doc.data());
  });

  for (const conf of confessionsList.slice(0, 10)) { // Show first 10
    const status = conf.status.charAt(0).toUpperCase() + conf.status.slice(1);
    const comments = conf.totalComments || 0;
    const likes = conf.likes || 0;
    
    confessionsText += `#${conf.confessionNumber} - ${status}\n`;
    confessionsText += `"${conf.text.substring(0, 50)}${conf.text.length > 50 ? '...' : ''}"\n`;
    confessionsText += `Comments: ${comments} | Likes: ${likes}\n\n`;
  }

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📝 Send New', callback_data: 'send_confession' },
          { text: '🔄 Refresh', callback_data: 'my_confessions' }
        ],
        [
          { text: '🔙 Back to Profile', callback_ 'my_profile' }
        ]
      ]
    }
  };

  await bot.sendMessage(chatId, confessionsText, { 
    parse_mode: 'Markdown',
    ...keyboard
  });
};

// ========== TRENDING CONFESSIONS ========== //
const handleTrending = async (msg) => {
  const chatId = msg.chat.id;

  const confessionsSnapshot = await db.collection('confessions')
    .where('status', '==', 'approved')
    .orderBy('totalComments', 'desc')
    .limit(5)
    .get();

  if (confessionsSnapshot.empty) {
    await bot.sendMessage(chatId, 
      `🔥 *Trending Confessions*\n\nNo trending confessions yet. Be the first to submit one!`
    );
    return;
  }

  let trendingText = `🔥 *Trending Confessions*\n\n`;

  const confessionsList = [];
  confessionsSnapshot.forEach(doc => {
    confessionsList.push(doc.data());
  });

  confessionsList.forEach((confession, index) => {
    trendingText += `${index + 1}. #${confession.confessionNumber}\n`;
    trendingText += `   ${confession.text.substring(0, 100)}${confession.text.length > 100 ? '...' : ''}\n`;
    trendingText += `   Comments: ${confession.totalComments || 0}\n\n`;
  });

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📝 Send Confession', callback_data: 'send_confession' },
          { text: '🔍 Browse Users', callback_ 'browse_users' }
        ],
        [
          { text: '🔙 Back to Menu', callback_ 'back_to_menu' }
        ]
      ]
    }
  };

  await bot.sendMessage(chatId, trendingText, { 
    parse_mode: 'Markdown',
    ...keyboard
  });
};

// ========== HASHTAGS ========== //
const handleHashtags = async (msg) => {
  const chatId = msg.chat.id;

  const confessionsSnapshot = await db.collection('confessions')
    .where('status', '==', 'approved')
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();

  const hashtagCount = {};
  confessionsSnapshot.forEach(doc => {
    const data = doc.data();
    const hashtags = extractHashtags(data.text);
    hashtags.forEach(tag => {
      hashtagCount[tag] = (hashtagCount[tag] || 0) + 1;
    });
  });

  const sortedHashtags = Object.entries(hashtagCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (sortedHashtags.length === 0) {
    await bot.sendMessage(chatId, 
      `🏷️ *Popular Hashtags*\n\nNo hashtags found yet. Use #hashtags in your confessions!`
    );
    return;
  }

  let hashtagsText = `🏷️ *Popular Hashtags*\n\n`;

  sortedHashtags.forEach(([tag, count], index) => {
    hashtagsText += `${index + 1}. ${tag} (${count} uses)\n`;
  });

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📝 Send Confession', callback_data: 'send_confession' },
          { text: '🔍 Browse Users', callback_ 'browse_users' }
        ],
        [
          { text: '🔙 Back to Menu', callback_ 'back_to_menu' }
        ]
      ]
    }
  };

  await bot.sendMessage(chatId, hashtagsText, { 
    parse_mode: 'Markdown',
    ...keyboard
  });
};

// ========== BEST COMMENTERS ========== //
const handleBestCommenters = async (msg) => {
  const chatId = msg.chat.id;

  // Count comments per user
  const commentCounts = {};
  const commentsSnapshot = await db.collection('comments').get();
  
  commentsSnapshot.forEach(doc => {
    const data = doc.data();
    if (data.comments) {
      for (const comment of data.comments) {
        const userId = comment.userId;
        commentCounts[userId] = (commentCounts[userId] || 0) + 1;
      }
    }
  });

  // Sort users by comment count
  const sortedUsers = Object.entries(commentCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (sortedUsers.length === 0) {
    await bot.sendMessage(chatId, 
      `🏆 *Best Commenters*\n\nNo comments yet. Be the first to comment!`
    );
    return;
  }

  let commentersText = `🏆 *Best Commenters - Weekly*\n\n`;

  for (let i = 0; i < sortedUsers.length; i++) {
    const [userId, count] = sortedUsers[i];
    const user = await getUser(parseInt(userId));
    const userLevel = getUserLevel(count);
    
    commentersText += `${i + 1}. ${userLevel.symbol} $${user?.username || 'Anonymous'} (${count} comments)\n`;
  }

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🔄 Weekly', callback_data: 'best_commenters_weekly' },
          { text: '📅 Monthly', callback_data: 'best_commenters_monthly' }
        ],
        [
          { text: '📈 All Time', callback_data: 'best_commenters_all' },
          { text: '🔍 View My Rank', callback_ 'view_my_rank' }
        ],
        [
          { text: '📝 Add Comment', callback_ 'add_comment' },
          { text: '🔙 Back to Menu', callback_ 'back_to_menu' }
        ]
      ]
    }
  };

  await bot.sendMessage(chatId, commentersText, { 
    parse_mode: 'Markdown',
    ...keyboard
  });
};

// ========== BROWSE USERS ========== //
const handleBrowseUsers = async (msg) => {
  const chatId = msg.chat.id;
  const currentUserId = msg.from.id;

  const usersSnapshot = await db.collection('users')
    .where('username', '!=', null)
    .where('isActive', '==', true)
    .where('telegramId', '!=', currentUserId)
    .orderBy('reputation', 'desc')
    .limit(10)
    .get();

  if (usersSnapshot.empty) {
    await bot.sendMessage(chatId, 
      `🔍 *Browse Users*\n\nNo users found.`
    );
    return;
  }

  let usersText = `🔍 *Browse Users*\n\n`;
  const keyboard = [];

  const usersList = [];
  usersSnapshot.forEach(doc => {
    usersList.push(doc.data());
  });

  for (const user of usersList) {
    const name = user.username;
    const bio = user.bio || 'No bio';
    const followers = user.followers?.length || 0;
    const reputation = user.reputation || 0;
    const commentCount = await getCommentCount(user.telegramId);
    const levelInfo = getUserLevel(commentCount);

    usersText += `• ${levelInfo.symbol} $${name} (${reputation}⭐, ${followers} followers)\n`;
    usersText += `  ${bio}\n\n`;

    keyboard.push([
      { text: `👤 View $${name}`, callback_data: `view_profile_${user.telegramId}` }
    ]);
  }

  keyboard.push([{ text: '🔙 Back to Menu', callback_ 'back_to_menu' }]);

  const inlineKeyboard = {
    reply_markup: {
      inline_keyboard: keyboard
    }
  };

  await bot.sendMessage(chatId, usersText, { 
    parse_mode: 'Markdown',
    ...inlineKeyboard
  });
};

// ========== ABOUT US ========== //
const handleAbout = async (msg) => {
  const chatId = msg.chat.id;
  
  const text = `ℹ️ *About Us*\n\nThis is an anonymous confession platform for JU students.\n\nFeatures:\n• Anonymous confessions\n• Admin approval system\n• User profiles\n• Social features\n• Comment system\n• Reputation system\n• Achievements\n• Level system\n• Best commenters\n• Promotion features\n\n100% private and secure.`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📝 Send Confession', callback_ 'send_confession' },
          { text: '📢 Promote Bot', callback_ 'promote_bot' }
        ],
        [
          { text: '🔍 Browse Users', callback_ 'browse_users' },
          { text: '🔙 Back to Menu', callback_ 'back_to_menu' }
        ]
      ]
    }
  };

  await bot.sendMessage(chatId, text, { 
    parse_mode: 'Markdown',
    ...keyboard
  });
};

// ========== RULES ========== //
const handleRules = async (msg) => {
  const chatId = msg.chat.id;
  
  const text = `📌 *Confession Rules*\n\n✅ Be respectful\n✅ No personal attacks\n✅ No spam or ads\n✅ Keep it anonymous\n✅ No hate speech\n✅ No illegal content\n✅ No harassment\n✅ Use appropriate hashtags`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📝 Send Confession', callback_ 'send_confession' },
          { text: '📢 Promote Bot', callback_ 'promote_bot' }
        ],
        [
          { text: '🔍 Browse Users', callback_ 'browse_users' },
          { text: '🔙 Back to Menu', callback_ 'back_to_menu' }
        ]
      ]
    }
  };

  await bot.sendMessage(chatId, text, { 
    parse_mode: 'Markdown',
    ...keyboard
  });
};

// ========== HANDLE CONFESSIOIN SUBMISSION ========== //
const handleConfessionSubmission = async (msg, text) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!text || text.trim().length < 5) {
    await bot.sendMessage(chatId, '❌ Confession too short. Minimum 5 characters.');
    return;
  }

  if (text.length > 1000) {
    await bot.sendMessage(chatId, '❌ Confession too long. Maximum 1000 characters.');
    return;
  }

  try {
    const sanitizedText = sanitizeInput(text);
    const confessionId = `confess_${userId}_${Date.now()}`;
    const hashtags = extractHashtags(sanitizedText);

    const confessionNumber = await incrementCounter('confessionNumber');
    const confessionData = {
      id: confessionId,
      confessionId: confessionId,
      userId: userId,
      text: sanitizedText.trim(),
      status: 'pending',
      createdAt: new Date().toISOString(),
      hashtags: hashtags,
      totalComments: 0,
      confessionNumber: confessionNumber,
      likes: 0
    };

    await createConfession(confessionData);

    // Update user stats
    await updateUser(userId, {
      totalConfessions: admin.firestore.FieldValue.increment(1)
    });

    // Set cooldown
    await setCooldown(userId, 'confession');

    // Notify admins
    await notifyAdmins(confessionId, sanitizedText);

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📝 Send Another', callback_ 'send_confession' },
            { text: '📢 Promote Bot', callback_ 'promote_bot' }
          ],
          [
            { text: '🔙 Back to Menu', callback_ 'back_to_menu' }
          ]
        ]
      }
    };

    await bot.sendMessage(chatId,
      `✅ *Confession Submitted!*\n\nYour confession is under review. You'll be notified when approved.`,
      { parse_mode: 'Markdown', ...keyboard }
    );

  } catch (error) {
    console.error('Submission error:', error);
    await bot.sendMessage(chatId, '❌ Error submitting confession. Please try again.');
  }
};

// ========== NOTIFY ADMINS ========== //
const notifyAdmins = async (confessionId, text) => {
  const message = `🤫 *New Confession*\n\n${text}\n\n*Actions:*`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_ `approve_${confessionId}` },
          { text: '❌ Reject', callback_ `reject_${confessionId}` }
        ]
      ]
    }
  };

  for (const adminId of ADMIN_IDS) {
    try {
      await bot.sendMessage(adminId, message, { 
        parse_mode: 'Markdown', 
        ...keyboard 
      });
    } catch (error) {
      console.error(`Admin notify error ${adminId}:`, error);
    }
  }
};

// ========== POST TO CHANNEL ========== //
const postToChannel = async (text, number, confessionId) => {
  const message = `#${number}\n\n${text}`;

  try {
    await bot.sendMessage(CHANNEL_ID, message);
    
    const commentMessage = `#${number}\n\n${text}\n\n[ 👁️‍🗨️ View/Add Comments (0) ] [ 👤 Follow Author ]`;
    
    await bot.sendMessage(CHANNEL_ID, commentMessage, {
      reply_markup: {
        inline_keyboard: [
          [
            { 
              text: '👁️‍🗨️ View/Add Comments', 
              url: `https://t.me/${BOT_USERNAME}?start=comments_${confessionId}`
            },
            { 
              text: '👤 Follow Author', 
              url: `https://t.me/${BOT_USERNAME}?start=profile_${confessionId}`
            }
          ]
        ]
      }
    });

    await updateComment(confessionId, {
      confessionId: confessionId,
      confessionNumber: number,
      confessionText: text,
      comments: [],
      totalComments: 0
    });
    
  } catch (error) {
    console.error('Channel post error:', error);
  }
};

// ========== NOTIFY USER ========== //
const notifyUser = async (userId, number, status, reason = '') => {
  try {
    let message = '';
    if (status === 'approved') {
      message = `🎉 *Your Confession #${number} was approved!*\n\nIt has been posted to the channel.\n\n⭐ +10 reputation points`;
    } else if (status === 'rejected') {
      message = `❌ *Confession Not Approved*\n\nReason: ${reason}\n\nYou can submit a new one.`;
    } else {
      message = `❌ *Confession Not Approved*\n\nReason: ${reason}\n\nYou can submit a new one.`;
    }

    await bot.sendMessage(userId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('User notify error:', error);
  }
};

// ========== VIEW COMMENTS ========== //
const handleViewComments = async (chatId, confessionId, page = 1) => {
  const commentData = await getComment(confessionId);
  
  if (!commentData) {
    await bot.sendMessage(chatId, '❌ Confession not found.');
    return;
  }

  const commentList = commentData.comments || [];
  const commentsPerPage = 3;
  const totalPages = Math.ceil(commentList.length / commentsPerPage);
  const startIndex = (page - 1) * commentsPerPage;
  const endIndex = startIndex + commentsPerPage;
  const pageComments = commentList.slice(startIndex, endIndex);

  let commentText = `💬 Comments for Confession #${commentData.confessionNumber}\n`;
  commentText += `This is the confession text...\n\n`;

  if (pageComments.length === 0) {
    commentText += 'No comments yet. Be the first to comment!\n\n';
  } else {
    commentText += `Comments (${startIndex + 1}-${Math.min(endIndex, commentList.length)} of ${commentList.length}):\n\n`;
    for (let i = 0; i < pageComments.length; i++) {
      const comment = pageComments[i];
      const user = await getUser(comment.userId);
      const userLevel = getUserLevel(await getCommentCount(comment.userId));
      
      commentText += `${startIndex + i + 1}. ${comment.text}\n`;
      commentText += `   - ${userLevel.symbol} $${user?.username || 'Anonymous'}\n\n`;
    }
  }

  const confession = await getConfession(confessionId);
  const author = await getUser(confession?.userId);

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📝 Add Comment', callback_ `add_comment_${confessionId}` },
          { text: author ? `👤 Follow $${author.username}` : '👤 Follow Author', callback_ `follow_author_${confessionId}` }
        ]
      ]
    }
  };

  // Add pagination buttons if needed
  if (totalPages > 1) {
    const paginationRow = [];
    
    if (page > 1) {
      paginationRow.push({ text: '⬅️ Previous', callback_ `comments_page_${confessionId}_${page - 1}` });
    }
    
    paginationRow.push({ text: `${page}/${totalPages}`, callback_ `comments_page_${confessionId}_${page}` });
    
    if (page < totalPages) {
      paginationRow.push({ text: 'Next ➡️', callback_ `comments_page_${confessionId}_${page + 1}` });
    }
    
    keyboard.reply_markup.inline_keyboard.push(paginationRow);
  }

  keyboard.reply_markup.inline_keyboard.push([
    { text: '👤 View Profile', callback_data: 'view_profile' },
    { text: '🔙 Back to Menu', callback_ 'back_to_menu' }
  ]);

  await bot.sendMessage(chatId, commentText, { 
    parse_mode: 'Markdown',
    ...keyboard
  });
};

// ========== ADD COMMENT ========== //
const handleAddComment = async (chatId, confessionId, commentText) => {
  const userId = chatId;
  
  if (!commentText || commentText.trim().length < 3) {
    await bot.sendMessage(chatId, '❌ Comment too short. Minimum 3 characters.');
    return;
  }

  if (!await checkCommentRateLimit(userId)) {
    await bot.sendMessage(chatId, '❌ Too many comments. Please wait before adding another comment.');
    return;
  }

  const commentData = await getComment(confessionId);
  if (!commentData) {
    await bot.sendMessage(chatId, '❌ Confession not found.');
    return;
  }

  const sanitizedComment = sanitizeInput(commentText);

  const newComment = {
    id: `comment_${Date.now()}_${userId}`,
    text: sanitizedComment.trim(),
    userId: userId,
    userName: (await getUser(userId)).firstName || 'Anonymous',
    timestamp: new Date().toLocaleString(),
    createdAt: new Date().toISOString()
  };

  const updatedComments = [...(commentData.comments || []), newComment];
  await updateComment(confessionId, {
    ...commentData,
    comments: updatedComments,
    totalComments: (commentData.totalComments || 0) + 1
  });

  // Update confession total comments
  await updateConfession(confessionId, {
    totalComments: admin.firestore.FieldValue.increment(1)
  });

  await recordComment(userId);

  const user = await getUser(userId);
  await updateUser(userId, {
    reputation: admin.firestore.FieldValue.increment(5)
  });

  await bot.sendMessage(chatId, '✅ Comment added successfully!');
  
  await handleViewComments(chatId, confessionId);
};

// ========== ADMIN COMMANDS ========== //
const handleAdmin = async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, '❌ Access denied. Admin only command.');
    return;
  }

  const usersSnapshot = await db.collection('users').get();
  const confessionsSnapshot = await db.collection('confessions').get();

  const totalUsers = usersSnapshot.size;
  const totalConfessions = confessionsSnapshot.size;
  const pendingConfessions = (await db.collection('confessions').where('status', '==', 'pending').get()).size;
  const approvedConfessions = (await db.collection('confessions').where('status', '==', 'approved').get()).size;
  const rejectedConfessions = (await db.collection('confessions').where('status', '==', 'rejected').get()).size;

  const text = `🔐 *Admin Dashboard*\n\n`;
  const usersStat = `**Total Users:** ${totalUsers}\n`;
  const confessionsStat = `**Pending Confessions:** ${pendingConfessions}\n`;
  const approvedStat = `**Approved Confessions:** ${approvedConfessions}\n`;
  const rejectedStat = `**Rejected Confessions:** ${rejectedConfessions}\n`;

  const fullText = text + usersStat + confessionsStat + approvedStat + rejectedStat;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '👥 Manage Users', callback_ 'manage_users' },
          { text: '📝 Review Confessions', callback_ 'review_confessions' }
        ],
        [
          { text: '📊 Bot Statistics', callback_ 'bot_stats' },
          { text: '❌ Block User', callback_ 'block_user' }
        ],
        [
          { text: '💬 Monitor Chats', callback_ 'monitor_chats' },
          { text: '👤 Add Admin', callback_ 'add_admin' }
        ],
        [
          { text: '🔧 Maintenance Mode', callback_ 'toggle_maintenance' },
          { text: '✉️ Message User', callback_ 'message_user' }
        ],
        [
          { text: '📢 Broadcast Message', callback_ 'broadcast_message' },
          { text: '⚙️ Bot Settings', callback_data: 'bot_settings' }
        ]
      ]
    }
  };

  await bot.sendMessage(chatId, fullText, { 
    parse_mode: 'Markdown',
    ...keyboard
  });
};

// ========== CALLBACK QUERY HANDLER ========== //
const handleCallbackQuery = async (callbackQuery) => {
  const message = callbackQuery.message;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;
  const chatId = message.chat.id;

  try {
    if (data.startsWith('approve_')) {
      const confessionId = data.replace('approve_', '');
      await handleApproveConfession(chatId, userId, confessionId, callbackQuery.id);
    } else if (data.startsWith('reject_')) {
      const confessionId = data.replace('reject_', '');
      await handleRejectConfession(chatId, userId, confessionId, callbackQuery.id);
    } else if (data.startsWith('add_comment_')) {
      const confessionId = data.replace('add_comment_', '');
      await handleStartComment(chatId, confessionId, callbackQuery.id);
    } else if (data.startsWith('comments_page_')) {
      const parts = data.split('_');
      const confessionId = parts[2];
      const page = parseInt(parts[3]);
      await handleViewComments(chatId, confessionId, page);
    } else if (data.startsWith('view_profile_')) {
      const targetUserId = parseInt(data.replace('view_profile_', ''));
      await handleViewProfile(chatId, targetUserId, callbackQuery.id);
    } else if (data.startsWith('follow_')) {
      const targetUserId = parseInt(data.replace('follow_', ''));
      await handleFollowUser(chatId, userId, targetUserId);
    } else if (data.startsWith('unfollow_')) {
      const targetUserId = parseInt(data.replace('unfollow_', ''));
      await handleUnfollowUser(chatId, userId, targetUserId);
    } else if (data === 'send_confession') {
      await handleSendConfession({ chat: { id: chatId }, from: { id: userId } });
    } else if (data === 'my_profile') {
      await handleMyProfile({ chat: { id: chatId }, from: { id: userId } });
    } else if (data === 'promote_bot') {
      await handlePromoteBot({ chat: { id: chatId }, from: { id: userId } });
    } else if (data === 'back_to_menu') {
      await showMainMenu(chatId);
    } else if (data === 'manage_users') {
      await handleManageUsers(chatId, userId);
    } else if (data === 'review_confessions') {
      await handleReviewConfessions(chatId, userId);
    } else if (data === 'bot_stats') {
      await handleBotStats(chatId, userId);
    } else if (data === 'block_user') {
      await handleStartBlockUser(chatId, userId);
    } else if (data === 'admin_menu') {
      await handleAdmin({ chat: { id: chatId }, from: { id: userId } });
    } else if (data === 'set_username') {
      await handleStartSetUsername(chatId, userId);
    } else if (data === 'set_bio') {
      await handleStartSetBio(chatId, userId);
    } else if (data === 'show_followers') {
      await handleShowFollowers({ chat: { id: chatId }, from: { id: userId } });
    } else if (data === 'show_following') {
      await handleShowFollowing({ chat: { id: chatId }, from: { id: userId } });
    } else if (data === 'view_achievements') {
      await handleAchievements({ chat: { id: chatId }, from: { id: userId } });
    } else if (data === 'browse_users') {
      await handleBrowseUsers({ chat: { id: chatId }, from: { id: userId } });
    } else if (data === 'my_confessions') {
      await handleMyConfessions(chatId, userId);
    } else if (data === 'comment_settings') {
      await handleCommentSettings(chatId, userId);
    } else if (data === 'view_rankings') {
      await handleBestCommenters({ chat: { id: chatId }, from: { id: userId } });
    } else if (data === 'view_my_rank') {
      await handleViewMyRank(chatId, userId);
    } else if (data === 'monitor_chats') {
      await handleMonitorChats(chatId, userId);
    } else if (data === 'add_admin') {
      await handleAddAdmin(chatId, userId);
    } else if (data === 'toggle_maintenance') {
      await handleToggleMaintenance(chatId, userId);
    } else if (data === 'message_user') {
      await handleMessageUser(chatId, userId);
    } else if (data === 'broadcast_message') {
      await handleBroadcastMessage(chatId, userId);
    } else if (data === 'bot_settings') {
      await handleBotSettings(chatId, userId);
    }

    await bot.answerCallbackQuery(callbackQuery.id);
  } catch (error) {
    console.error('Callback error:', error);
    await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Error processing request' });
  }
};

// ========== ADMIN CONFIRMATION HANDLERS ========== //
const handleApproveConfession = async (chatId, userId, confessionId, callbackQueryId) => {
  if (!isAdmin(userId)) {
    await bot.answerCallbackQuery(callbackQueryId, { text: '❌ Access denied' });
    return;
  }

  const confession = await getConfession(confessionId);
  if (!confession) {
    await bot.answerCallbackQuery(callbackQueryId, { text: '❌ Confession not found' });
    return;
  }

  await updateConfession(confessionId, {
    status: 'approved',
    approvedAt: new Date().toISOString()
  });

  const user = await getUser(confession.userId);
  await updateUser(confession.userId, {
    reputation: admin.firestore.FieldValue.increment(10)
  });

  await postToChannel(confession.text, confession.confessionNumber, confessionId);
  await notifyUser(confession.userId, confession.confessionNumber, 'approved');

  try {
    await bot.editMessageText(
      `✅ *Confession #${confession.confessionNumber} Approved!*\n\nPosted to channel successfully.`,
      { 
        chat_id: chatId,
        message_id: message.message_id,
        parse_mode: 'Markdown'
      }
    );
  } catch (editError) {
    await bot.sendMessage(chatId, 
      `✅ *Confession #${confession.confessionNumber} Approved!*\n\nPosted to channel successfully.`
    );
  }
  
  await bot.answerCallbackQuery(callbackQueryId, { text: 'Approved!' });
};

const handleRejectConfession = async (chatId, userId, confessionId, callbackQueryId) => {
  if (!isAdmin(userId)) {
    await bot.answerCallbackQuery(callbackQueryId, { text: '❌ Access denied' });
    return;
  }

  userStates.set(userId, {
    state: 'awaiting_rejection_reason',
    confessionId: confessionId,
    originalCallbackQueryId: callbackQueryId
  });

  await bot.editMessageText(
    `❌ *Rejecting Confession*\n\nPlease provide rejection reason:`,
    { 
      chat_id: chatId,
      message_id: message.message_id,
      parse_mode: 'Markdown'
    }
  );
};

const handleStartComment = async (chatId, confessionId, callbackQueryId) => {
  userStates.set(chatId, {
    state: 'awaiting_comment',
    confessionId: confessionId
  });

  await bot.editMessageText(
    `📝 *Add Comment*\n\nType your comment for this confession:`,
    { 
      chat_id: chatId,
      message_id: message.message_id,
      parse_mode: 'Markdown'
    }
  );
};

const handleViewProfile = async (chatId, targetUserId, callbackQueryId) => {
  const targetUser = await getUser(targetUserId);
  const currentUser = await getUser(chatId);

  if (!targetUser) {
    await bot.answerCallbackQuery(callbackQueryId, { text: '❌ User not found' });
    return;
  }

  const commentCount = await getCommentCount(targetUserId);
  const levelInfo = getUserLevel(commentCount);

  const profileText = `👤 *Profile*\n\n`;
  const username = targetUser.username ? `**Username:** $${targetUser.username}\n` : '';
  const level = `**Level:** ${levelInfo.symbol} ${levelInfo.name} (${commentCount} comments)\n`;
  const bio = targetUser.bio ? `**Bio:** ${targetUser.bio}\n` : `**Bio:** No bio\n`;
  const followers = `**Followers:** ${targetUser.followers?.length || 0}\n`;
  const following = `**Following:** ${targetUser.following?.length || 0}\n`;
  const confessions = `**Confessions:** ${targetUser.totalConfessions || 0}\n`;
  const reputation = `**Reputation:** ${targetUser.reputation || 0}⭐\n`;
  const achievements = `**Achievements:** ${targetUser.achievements?.length || 0}\n`;
  const joinDate = `**Member Since:** ${new Date(targetUser.joinedAt).toLocaleDateString()}\n`;

  const fullText = profileText + username + level + bio + followers + following + confessions + reputation + achievements + joinDate;

  const isFollowing = (currentUser?.following || []).includes(targetUserId);
  
  const keyboard = [
    [isFollowing 
      ? { text: '✅ Following', callback_data: `unfollow_${targetUserId}` }
      : { text: '➕ Follow', callback_data: `follow_${targetUserId}` }
    ]
  ];
  
  keyboard.push([{ text: '💬 Message', callback_data: `message_user_${targetUserId}` }]);
  keyboard.push([{ text: '🔙 Back to Menu', callback_ 'back_to_menu' }]);

  try {
    await bot.editMessageText(fullText, { 
      chat_id: chatId,
      message_id: message.message_id,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (error) {
    await bot.sendMessage(chatId, fullText, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  }
};

// ========== MANAGE USERS (ADMIN) ========== //
const handleManageUsers = async (chatId, userId) => {
  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, '❌ Access denied');
    return;
  }

  const usersSnapshot = await db.collection('users').limit(10).get();
  
  let userText = `👥 *Manage Users*\n\nTotal Users: ${usersSnapshot.size}\n\n`;
  const keyboard = [];
  
  usersSnapshot.forEach(doc => {
    const userData = doc.data();
    const username = userData.username || 'No username';
    keyboard.push([
      { text: `🔍 View $${username}`, callback_ `view_user_${userData.telegramId}` }
    ]);
  });
  
  keyboard.push([{ text: '🔙 Admin Menu', callback_ 'admin_menu' }]);

  await bot.sendMessage(chatId, userText, { 
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
};

// ========== REVIEW CONFESSIONS (ADMIN) ========== //
const handleReviewConfessions = async (chatId, userId) => {
  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, '❌ Access denied');
    return;
  }

  const confessionsSnapshot = await db.collection('confessions')
    .where('status', '==', 'pending')
    .orderBy('createdAt', 'asc')
    .limit(10)
    .get();

  if (confessionsSnapshot.empty) {
    await bot.sendMessage(chatId, 
      `📝 *Pending Confessions*\n\nNo pending confessions to review.`
    );
    return;
  }

  let confessionsText = `📝 *Pending Confessions*\n\n`;

  const confessionsList = [];
  confessionsSnapshot.forEach(doc => {
    confessionsList.push(doc.data());
  });

  for (const conf of confessionsList) {
    const user = await getUser(conf.userId);
    const username = user?.username ? `$${user.username}` : `ID: ${conf.userId}`;
    
    confessionsText += `• From: ${username}\n`;
    confessionsText += `  Confession: "${conf.text.substring(0, 50)}${conf.text.length > 50 ? '...' : ''}"\n\n`;
  }

  const keyboard = [];

  for (const conf of confessionsList) {
    keyboard.push([
      { text: `✅ Approve #${conf.confessionNumber}`, callback_ `approve_${conf.confessionId}` },
      { text: `❌ Reject #${conf.confessionNumber}`, callback_ `reject_${conf.confessionId}` }
    ]);
  }

  keyboard.push([{ text: '🔙 Admin Menu', callback_data: 'admin_menu' }]);

  await bot.sendMessage(chatId, confessionsText, { 
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
};

// ========== ADDITIONAL ADMIN HANDLERS ========== //
const handleBotStats = async (chatId, userId) => {
  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, '❌ Access denied');
    return;
  }

  const usersSnapshot = await db.collection('users').get();
  const confessionsSnapshot = await db.collection('confessions').get();
  const commentsSnapshot = await db.collection('comments').get();

  const totalUsers = usersSnapshot.size;
  const totalConfessions = confessionsSnapshot.size;
  const pendingConfessions = (await db.collection('confessions').where('status', '==', 'pending').get()).size;
  const approvedConfessions = (await db.collection('confessions').where('status', '==', 'approved').get()).size;
  const rejectedConfessions = (await db.collection('confessions').where('status', '==', 'rejected').get()).size;
  
  let totalComments = 0;
  commentsSnapshot.forEach(doc => {
    const data = doc.data();
    totalComments += data.comments?.length || 0;
  });

  const statsText = `📊 *Bot Statistics*\n\n`;
  const usersStat = `**Total Users:** ${totalUsers}\n`;
  const confessionsStat = `**Total Confessions:** ${totalConfessions}\n`;
  const pendingStat = `**Pending Confessions:** ${pendingConfessions}\n`;
  const approvedStat = `**Approved Confessions:** ${approvedConfessions}\n`;
  const rejectedStat = `**Rejected Confessions:** ${rejectedConfessions}\n`;
  const commentsStat = `**Total Comments:** ${totalComments}\n`;

  const fullText = statsText + usersStat + confessionsStat + pendingStat + approvedStat + rejectedStat + commentsStat;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '👥 Manage Users', callback_data: 'manage_users' },
          { text: '📝 Review Confessions', callback_ 'review_confessions' }
        ],
        [
          { text: '🔙 Admin Menu', callback_ 'admin_menu' }
        ]
      ]
    }
  };

  await bot.sendMessage(chatId, fullText, { 
    parse_mode: 'Markdown',
    ...keyboard
  });
};

const handleStartBlockUser = async (chatId, userId) => {
  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, '❌ Access denied');
    return;
  }

  await bot.sendMessage(chatId, 
    `❌ *Block User*\n\nEnter user ID to block:`
  );
};

// ========== PROFILE MANAGEMENT ========== //
const handleStartSetUsername = async (chatId, userId) => {
  userStates.set(userId, {
    state: 'awaiting_username',
    originalChatId: chatId
  });

  await bot.sendMessage(chatId, 
    `📝 *Set Username*\n\nEnter your desired username (without $ symbol):\n\nMust be 3-20 characters, letters/numbers/underscores only.`
  );
};

const handleStartSetBio = async (chatId, userId) => {
  userStates.set(userId, {
    state: 'awaiting_bio',
    originalChatId: chatId
  });

  await bot.sendMessage(chatId, 
    `📝 *Set Bio*\n\nEnter your bio (max 100 characters):`
  );
};

const handleShowFollowers = async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const user = await getUser(userId);

  const followers = user.followers || [];
  
  if (followers.length === 0) {
    await bot.sendMessage(chatId, 
      `👥 *Your Followers*\n\nNo followers yet.`
    );
    return;
  }

  let followersText = `👥 *Your Followers (${followers.length})*\n\n`;
  
  for (const followerId of followers) {
    const follower = await getUser(followerId);
    const name = follower?.username ? `$${follower.username}` : 'Anonymous';
    const commentCount = await getCommentCount(followerId);
    const levelInfo = getUserLevel(commentCount);
    followersText += `• ${levelInfo.symbol} ${name}\n`;
  }

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🔍 Browse Users', callback_ 'browse_users' },
          { text: '🔙 Back to Menu', callback_ 'back_to_menu' }
        ]
      ]
    }
  };

  await bot.sendMessage(chatId, followersText, { 
    parse_mode: 'Markdown',
    ...keyboard
  });
};

const handleShowFollowing = async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const user = await getUser(userId);

  const following = user.following || [];
  
  if (following.length === 0) {
    await bot.sendMessage(chatId, 
      `👥 *You're Following*\n\nNot following anyone yet.`
    );
    return;
  }

  let followingText = `👥 *You're Following (${following.length})*\n\n`;
  
  for (const followingId of following) {
    const followee = await getUser(followingId);
    const name = followee?.username ? `$${followee.username}` : 'Anonymous';
    const commentCount = await getCommentCount(followingId);
    const levelInfo = getUserLevel(commentCount);
    followingText += `• ${levelInfo.symbol} ${name}\n`;
  }

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🔍 Browse Users', callback_ 'browse_users' },
          { text: '🔙 Back to Menu', callback_ 'back_to_menu' }
        ]
      ]
    }
  };

  await bot.sendMessage(chatId, followingText, { 
    parse_mode: 'Markdown',
    ...keyboard
  });
};

// ========== USER MANAGEMENT ========== //
const handleViewUser = async (chatId, adminId, targetUserId) => {
  if (!isAdmin(adminId)) {
    await bot.sendMessage(chatId, '❌ Access denied');
    return;
  }

  const user = await getUser(targetUserId);
  if (!user) {
    await bot.sendMessage(chatId, '❌ User not found');
    return;
  }

  const commentCount = await getCommentCount(targetUserId);
  const levelInfo = getUserLevel(commentCount);

  const text = `👤 *User Details*\n\n`;
  const id = `**User ID:** ${user.telegramId}\n`;
  const username = user.username ? `**Username:** $${user.username}\n` : '';
  const level = `**Level:** ${levelInfo.symbol} ${levelInfo.name} (${commentCount} comments)\n`;
  const bio = user.bio ? `**Bio:** ${user.bio}\n` : '';
  const followers = `**Followers:** ${user.followers?.length || 0}\n`;
  const following = `**Following:** ${user.following?.length || 0}\n`;
  const confessions = `**Confessions:** ${user.totalConfessions || 0}\n`;
  const reputation = `**Reputation:** ${user.reputation || 0}\n`;
  const achievements = `**Achievements:** ${user.achievements?.length || 0}\n`;
  const status = `**Status:** ${user.isActive ? '✅ Active' : '❌ Blocked'}\n`;
  const joinDate = `**Join Date:** ${new Date(user.joinedAt).toLocaleDateString()}\n`;

  const fullText = text + id + username + level + bio + followers + following + confessions + reputation + achievements + status + joinDate;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '✉️ Message User', callback_data: `message_user_${targetUserId}` },
        { text: user.isActive ? '❌ Block User' : '✅ Unblock User', callback_ `toggle_block_${targetUserId}` }
      ],
      [
        { text: '👥 View Confessions', callback_data: `view_user_confessions_${targetUserId}` },
        { text: '🔙 Back to Users', callback_ 'manage_users' }
      ]
    ]
  };

  await bot.sendMessage(chatId, fullText, { 
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
};

const handleFollowUser = async (chatId, userId, targetUserId) => {
  const currentUser = await getUser(userId);
  const targetUser = await getUser(targetUserId);

  if (!currentUser || !targetUser) {
    await bot.sendMessage(chatId, '❌ User not found');
    return;
  }

  if (userId === targetUserId) {
    await bot.sendMessage(chatId, '❌ You cannot follow yourself');
    return;
  }

  const currentFollowing = [...(currentUser.following || []), targetUserId];
  const targetFollowers = [...(targetUser.followers || []), userId];
  
  await updateUser(userId, { following: currentFollowing });
  await updateUser(targetUserId, { followers: targetFollowers });

  await bot.sendMessage(chatId, `✅ Following $${targetUser.username || 'User'}!`);
};

const handleUnfollowUser = async (chatId, userId, targetUserId) => {
  const currentUser = await getUser(userId);
  const targetUser = await getUser(targetUserId);

  if (!currentUser || !targetUser) {
    await bot.sendMessage(chatId, '❌ User not found');
    return;
  }

  const currentFollowing = (currentUser.following || []).filter(id => id !== targetUserId);
  const targetFollowers = (targetUser.followers || []).filter(id => id !== userId);
  
  await updateUser(userId, { following: currentFollowing });
  await updateUser(targetUserId, { followers: targetFollowers });

  await bot.sendMessage(chatId, `❌ Unfollowed $${targetUser.username || 'User'}`);
};

// ========== HELP COMMAND ========== //
const handleHelp = async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const isAdmin = ADMIN_IDS.includes(userId);

  let helpMessage = `ℹ️ *JU Confession Bot Help*\n\n` +
    `*How to Confess:*\n` +
    `1. Click "📝 Send Confession"\n` +
    `2. Type your confession\n` +
    `3. Wait for admin approval\n` +
    `4. See it posted in the channel\n\n` +
    `*Features:*\n` +
    `• Anonymous confessions\n` +
    `• User profiles with $username\n` +
    `• Social features (follow/unfollow)\n` +
    `• Reputation system\n` +
    `• Achievements\n` +
    `• User levels with symbols\n` +
    `• Best commenters leaderboard\n` +
    `• Promotion features\n\n` +
    `*Commands:*\n` +
    `/start - Start the bot\n` +
    `/help - Show this help\n`;

  if (isAdmin) {
    helpMessage += `\n*⚡ Admin Commands:*\n` +
      `/admin - Admin panel\n`;
  }

  await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
};

// ========== SETTINGS COMMAND ========== //
const handleSettings = async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, 
    `⚙️ *Settings*\n\n` +
    `Settings coming soon!\n\n` +
    `Current features:\n` +
    `• Username: Set in profile\n` +
    `• Bio: Set in profile\n` +
    `• Achievement tracking`,
    { parse_mode: 'Markdown' }
  );
};

// ========== COMMENT SETTINGS ========== //
const handleCommentSettings = async (chatId, userId) => {
  const user = await getUser(userId);
  
  const settings = user.commentSettings || {};
  
  let settingsText = `🔒 *Comment Settings*\n\n`;
  settingsText += `Your confessions can receive comments:\n`;
  settingsText += `• From Everyone: ${settings.allowComments === 'everyone' ? '✅' : '❌'}\n`;
  settingsText += `• Only Followers: ${settings.allowComments === 'followers' ? '✅' : '❌'}\n`;
  settingsText += `• Admin Only: ${settings.allowComments === 'admin' ? '✅' : '❌'}\n\n`;
  settingsText += `Anonymous comments: ${settings.allowAnonymous ? '✅' : '❌'}\n`;
  settingsText += `Comment approval: ${settings.requireApproval ? '✅ Manual Approval' : '❌ Disabled'}\n`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: settings.allowComments === 'everyone' ? '✅ From Everyone' : '❌ From Everyone', callback_ 'comment_everyone' },
          { text: settings.allowComments === 'followers' ? '✅ Only Followers' : '❌ Only Followers', callback_ 'comment_followers' }
        ],
        [
          { text: settings.allowAnonymous ? '✅ Anonymous' : '❌ Anonymous', callback_data: 'comment_anon' },
          { text: settings.requireApproval ? '✅ Manual Approval' : '❌ Manual Approval', callback_ 'comment_approve' }
        ],
        [
          { text: '💾 Save Settings', callback_ 'save_comment_settings' },
          { text: '🔙 Back to Profile', callback_ 'my_profile' }
        ]
      ]
    }
  };

  await bot.sendMessage(chatId, settingsText, { 
    parse_mode: 'Markdown',
    ...keyboard
  });
};

// ========== VIEW MY RANK ========== //
const handleViewMyRank = async (chatId, userId) => {
  const commentCount = await getCommentCount(userId);
  const levelInfo = getUserLevel(commentCount);

  // Count all users' comments
  const commentCounts = {};
  const commentsSnapshot = await db.collection('comments').get();
  
  commentsSnapshot.forEach(doc => {
    const data = doc.data();
    if (data.comments) {
      for (const comment of data.comments) {
        const userId = comment.userId;
        commentCounts[userId] = (commentCounts[userId] || 0) + 1;
      }
    }
  });

  const sortedUsers = Object.entries(commentCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ id: parseInt(id), count }));

  const userRank = sortedUsers.findIndex(user => user.id === userId) + 1;

  let rankText = `🏆 *Your Comment Rank*\n\n`;
  rankText += `Level: ${levelInfo.symbol} ${levelInfo.name}\n`;
  rankText += `Comments: ${commentCount}\n`;
  rankText += `Rank: #${userRank} of ${sortedUsers.length} users\n\n`;
  rankText += `Keep commenting to climb the leaderboard!`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📝 Add Comment', callback_data: 'add_comment' },
          { text: '🏆 View Rankings', callback_ 'best_commenters' }
        ],
        [
          { text: '🔙 Back to Menu', callback_ 'back_to_menu' }
        ]
      ]
    }
  };

  await bot.sendMessage(chatId, rankText, { 
    parse_mode: 'Markdown',
    ...keyboard
  });
};

// ========== ADMIN MONITOR CHATS ========== //
const handleMonitorChats = async (chatId, userId) => {
  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, '❌ Access denied');
    return;
  }

  let chatsText = `💬 *Monitor Private Chats*\n\n`;
  chatsText += `Recent private messages:\n\n`;
  chatsText += 'No recent chats to monitor.\n';

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🔄 Refresh', callback_ 'monitor_chats' },
          { text: '🔍 Search User', callback_ 'search_user' }
        ],
        [
          { text: '🔙 Admin Menu', callback_ 'admin_menu' }
        ]
      ]
    }
  };

  await bot.sendMessage(chatId, chatsText, { 
    parse_mode: 'Markdown',
    ...keyboard
  });
};

// ========== ADMIN ADD ADMIN ========== //
const handleAddAdmin = async (chatId, userId) => {
  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, '❌ Access denied');
    return;
  }

  await bot.sendMessage(chatId, 
    `👤 *Add New Admin*\n\nEnter user ID to make admin:\n(Use @userinfobot to get user ID)\n\nUser ID: ___________\n\nPermissions:\n✅ View Chats\n✅ Manage Users\n✅ Approve Confessions\n✅ Block Users\n✅ Add Admins\n✅ Maintenance Mode`
  );
};

// ========== ADMIN MAINTENANCE MODE ========== //
const handleToggleMaintenance = async (chatId, userId) => {
  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, '❌ Access denied');
    return;
  }

  const maintenanceDoc = await db.collection('system').doc('maintenance').get();
  const currentMode = maintenanceDoc.exists ? maintenanceDoc.data().enabled : false;
  const newMode = !currentMode;

  await db.collection('system').doc('maintenance').set({
    enabled: newMode,
    updatedAt: new Date().toISOString()
  });

  await bot.sendMessage(chatId, 
    `🔧 Maintenance Mode: ${newMode ? '✅ Enabled' : '❌ Disabled'}\n\nThe bot is now ${newMode ? 'under maintenance' : 'operational'}.`
  );
};

// ========== ADMIN MESSAGE USER ========== //
const handleMessageUser = async (chatId, userId) => {
  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, '❌ Access denied');
    return;
  }

  await bot.sendMessage(chatId, 
    `✉️ *Message User*\n\nEnter user ID or username:\n\nUser ID: ___________\n\nMessage Type:\n• Private Message\n• Broadcast\n\nMessage Content:\nType your message here...`
  );
};

// ========== ADMIN BROADCAST MESSAGE ========== //
const handleBroadcastMessage = async (chatId, userId) => {
  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, '❌ Access denied');
    return;
  }

  await bot.sendMessage(chatId, 
    `📢 *Broadcast Message*\n\nMessage Type:\n• To All Users\n• To Active Users\n• To Verified Users\n\nMessage Content:\nType your broadcast message...`
  );
};

// ========== ADMIN BOT SETTINGS ========== //
const handleBotSettings = async (chatId, userId) => {
  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, '❌ Access denied');
    return;
  }

  await bot.sendMessage(chatId, 
    `⚙️ *Bot Settings*\n\n• Maintenance Mode\n• User Limits\n• Rate Limits\n• Channel Settings\n• Admin Permissions\n• Message Templates\n\nUse admin panel for configuration.`
  );
};

// ========== MESSAGE HANDLER ========== //
const handleMessage = async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  if (!text) return;

  const userState = userStates.get(userId);
  
  if (userState && userState.state === 'awaiting_username') {
    if (text.length < 3 || text.length > 20 || !/^[a-zA-Z0-9_]+$/.test(text)) {
      await bot.sendMessage(chatId, '❌ Invalid username. Use 3-20 characters (letters, numbers, underscores only).');
      return;
    }

    // Check if username already exists
    const usersSnapshot = await db.collection('users').where('username', '==', text).limit(1).get();
    if (!usersSnapshot.empty && usersSnapshot.docs[0].data().telegramId !== userId) {
      await bot.sendMessage(chatId, '❌ Username already taken. Choose another one.');
      return;
    }

    await updateUser(userId, { username: text });
    userStates.delete(userId);
    
    await bot.sendMessage(chatId, `✅ Username updated to $${text}!`);
    await showMainMenu(chatId);
    return;
  }

  if (userState && userState.state === 'awaiting_confession') {
    await handleConfessionSubmission(msg, text);
    userStates.delete(userId);
    return;
  }

  if (userState && userState.state === 'awaiting_comment') {
    await handleAddComment(chatId, userState.confessionId, text);
    userStates.delete(userId);
    return;
  }

  if (userState && userState.state === 'awaiting_bio') {
    if (text.length > 100) {
      await bot.sendMessage(chatId, '❌ Bio too long. Maximum 100 characters.');
      return;
    }

    await updateUser(userId, { bio: text });
    userStates.delete(userId);
    await bot.sendMessage(chatId, '✅ Bio updated successfully!');
    return;
  }

  if (userState && userState.state === 'awaiting_rejection_reason' && isAdmin(userId)) {
    const confessionId = userState.confessionId;
    const confession = await getConfession(confessionId);
    
    if (confession) {
      await updateConfession(confessionId, {
        status: 'rejected',
        rejectionReason: text
      });

      await notifyUser(confession.userId, 0, 'rejected', text);
      
      await bot.sendMessage(chatId, `✅ Confession rejected.`);
    }
    userStates.delete(userId);
    return;
  }

  if (text.startsWith('/')) {
    switch (text) {
      case '/start':
        await handleStart(msg);
        break;
      case '/admin':
        await handleAdmin(msg);
        break;
      case '/help':
        await handleHelp(msg);
        break;
      default:
        await showMainMenu(chatId);
    }
  } else {
    switch (text) {
      case '📝 Send Confession':
        await handleSendConfession(msg);
        break;
      case '👤 My Profile':
        await handleMyProfile(msg);
        break;
      case '🔥 Trending':
        await handleTrending(msg);
        break;
      case '📢 Promote Bot':
        await handlePromoteBot(msg);
        break;
      case '🏷️ Hashtags':
        await handleHashtags(msg);
        break;
      case '🏆 Best Commenters':
        await handleBestCommenters(msg);
        break;
      case '🔍 Browse Users':
        await handleBrowseUsers(msg);
        break;
      case 'ℹ️ About Us':
        await handleAbout(msg);
        break;
      case '📌 Rules':
        await handleRules(msg);
        break;
      case '⚙️ Settings':
        await handleSettings(msg);
        break;
      default:
        await showMainMenu(chatId);
    }
  }
};

// ========== VERCEL HANDLER ========== //
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'online',
      message: 'JU Confession Bot is running on Vercel!',
      timestamp: new Date().toISOString(),
      stats: {
        users: (await db.collection('users').get()).size,
        confessions: (await db.collection('confessions').get()).size,
        comments: (await db.collection('comments').get()).size
      }
    });
  }

  if (req.method === 'POST') {
    try {
      const update = req.body;

      if (update.message) {
        await handleMessage(update.message);
      } else if (update.callback_query) {
        await handleCallbackQuery(update.callback_query);
      }

      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error('Error processing update:', error);
      return res.status(200).json({ error: 'Internal server error', acknowledged: true });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

console.log('✅ JU Confession Bot configured for Vercel!');
