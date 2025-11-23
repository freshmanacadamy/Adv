const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');

// Initialize Firebase with proper error handling
try {
  const serviceAccount = {
    type: "service_account",
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
  };

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('✅ Firebase initialized successfully');
  }

  const db = admin.firestore();
  const bot = new TelegramBot(process.env.BOT_TOKEN);

  // Environment Validation
  console.log('🔧 Environment Check:');
  console.log('BOT_TOKEN:', process.env.BOT_TOKEN ? '✅ Set' : '❌ Missing');
  console.log('CHANNEL_ID:', process.env.CHANNEL_ID ? '✅ Set' : '❌ Missing');
  console.log('ADMIN_IDS:', process.env.ADMIN_IDS ? '✅ Set' : '❌ Missing');
  console.log('BOT_USERNAME:', process.env.BOT_USERNAME ? '✅ Set' : '❌ Missing');

  if (!process.env.ADMIN_IDS) {
    console.error('❌ CRITICAL: ADMIN_IDS environment variable is not set!');
  }
  if (!process.env.CHANNEL_ID) {
    console.error('❌ CRITICAL: CHANNEL_ID environment variable is not set!');
  }

  // ========== DATABASE FUNCTIONS ========== //
  async function getUser(userId, msg = null) {
    const userDoc = await db.collection('users').doc(userId.toString()).get();
    if (!userDoc.exists) {
      const newUser = {
        telegramId: userId,
        username: 'Anonymous',
        firstName: msg?.from?.first_name || null,
        lastName: msg?.from?.last_name || null,
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
    
    const userData = userDoc.data();
    // Ensure isActive exists and defaults to true if not set
    if (userData.isActive === undefined) {
      await updateUser(userId, { isActive: true });
      userData.isActive = true;
    }
    
    // Ensure username exists and defaults to 'Anonymous'
    if (!userData.username) {
      await updateUser(userId, { username: 'Anonymous' });
      userData.username = 'Anonymous';
    }
    
    return userData;
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

  // ========== STATE MANAGEMENT WITH FIREBASE ========== //
  async function getUserState(userId) {
    const stateDoc = await db.collection('user_states').doc(userId.toString()).get();
    return stateDoc.exists ? stateDoc.data() : null;
  }

  async function setUserState(userId, stateData) {
    await db.collection('user_states').doc(userId.toString()).set(stateData);
  }

  async function clearUserState(userId) {
    await db.collection('user_states').doc(userId.toString()).delete();
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
    const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(Number) : [];
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
    try {
      const commentsSnapshot = await db.collection('comments').get();
      
      commentsSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.comments && Array.isArray(data.comments)) {
          for (const comment of data.comments) {
            if (comment.userId === userId) {
              count++;
            }
          }
        }
      });
    } catch (error) {
      console.error('Comment count error:', error);
    }
    
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
    const rateLimitRef = db.collection('rate_limits').doc(userId.toString());
    
    try {
      const rateLimitDoc = await rateLimitRef.get();
      
      if (!rateLimitDoc.exists) {
        await rateLimitRef.set({
          commentTimestamps: [now]
        });
      } else {
        await rateLimitRef.update({
          commentTimestamps: admin.firestore.FieldValue.arrayUnion(now)
        });
      }
    } catch (error) {
      console.error('Rate limit recording error:', error);
    }
  }

  // ========== NOTIFICATION SYSTEM ========== //
  async function sendNotification(userId, message, settingName) {
    try {
      const user = await getUser(userId);
      const notifications = user.notifications || {};
      
      if (notifications[settingName] !== false) {
        await bot.sendMessage(userId, message, { parse_mode: 'Markdown' });
      }
    } catch (error) {
      console.error('Notification error:', error);
    }
  }

  // ========== MAIN MENU ========== //
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
          [{ text: '🔥 Trending' }, { text: '📢 Promote Bot' }],
          [{ text: '🏷️ Hashtags' }, { text: '🏆 Best Commenters' }],
          [{ text: '⚙️ Settings' }, { text: 'ℹ️ About Us' }],
          [{ text: '🔍 Browse Users' }, { text: '📌 Rules' }]
        ],
        resize_keyboard: true
      }
    };

    await bot.sendMessage(chatId,
      `🤫 *JU Confession Bot*\n\n` +
      `👤 Profile: ${user.username || 'Not set'}\n` +
      `⭐ Reputation: ${reputation}\n` +
      `🔥 Streak: ${streak} days\n` +
      `🏆 Level: ${levelInfo.symbol} ${levelInfo.name} (${commentCount} comments)\n\n` +
      `Choose an option below:`,
      { parse_mode: 'Markdown', ...options }
    );
  };

// ========== START COMMAND ========== //
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
  const user = await getUser(userId, msg);
  
  if (user.isActive === false) {
    await bot.sendMessage(chatId, '❌ Your account has been blocked by admin.');
    return;
  }

  // If user doesn't have a username, prompt them to set one
  if (!user.username || user.username === 'Anonymous') {
    await bot.sendMessage(chatId,
      `🤫 *Welcome to JU Confession Bot!*\n\n` +
      `First, please set your display name:\n\n` +
      `Enter your desired name (3-20 characters, letters/numbers/underscores only):`
    );
    
    await setUserState(userId, {
      state: 'awaiting_username',
      originalChatId: chatId
    });
    return;
  }

  await bot.sendMessage(chatId,
    `🤫 *Welcome back, ${user.username}!*\n\n` +
    `Send me your confession and it will be submitted anonymously for admin approval.\n\n` +
    `Your identity will never be revealed!`,
    { parse_mode: 'Markdown' }
  );

  await showMainMenu(chatId);
};

// ========== PROMOTE BOT ========== //
const handlePromoteBot = async (msg) => {
  const chatId = msg.chat.id;
  const BOT_USERNAME = process.env.BOT_USERNAME;
  const CHANNEL_ID = process.env.CHANNEL_ID;
  
  await bot.sendMessage(chatId,
    `📢 *Help Us Grow!*\n\n` +
    `Share our bot with friends:\n` +
    `https://t.me/${BOT_USERNAME}\n\n` +
    `Join our channel for confessions:`,
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
            { text: '🔙 Back to Menu', callback_data: 'back_to_menu' }
          ]
        ]
      }
    }
  );
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

  await setUserState(userId, {
    state: 'awaiting_confession'
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
  const username = `**Display Name:** ${user.username}\n`;
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
          { text: '📝 Set Bio', callback_data: 'set_bio' }
        ],
        [
          { text: '🔒 Comment Settings', callback_data: 'comment_settings' },
          { text: '🔔 Notification Settings', callback_data: 'notification_settings' }
        ],
        [
          { text: '📝 My Confessions', callback_data: 'my_confessions' },
          { text: '👥 Followers', callback_data: 'show_followers' }
        ],
        [
          { text: '👥 Following', callback_data: 'show_following' },
          { text: '🏆 View Achievements', callback_data: 'view_achievements' }
        ],
        [
          { text: '🏆 View Rankings', callback_data: 'view_rankings' },
          { text: '🔍 Browse Users', callback_data: 'browse_users' }
        ],
        [
          { text: '🔙 Back to Menu', callback_data: 'back_to_menu' }
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

  for (const conf of confessionsList.slice(0, 10)) {
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
          { text: '🔙 Back to Profile', callback_data: 'my_profile' }
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
          { text: '🔍 Browse Users', callback_data: 'browse_users' }
        ],
        [
          { text: '🔙 Back to Menu', callback_data: 'back_to_menu' }
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
          { text: '🔍 Browse Users', callback_data: 'browse_users' }
        ],
        [
          { text: '🔙 Back to Menu', callback_data: 'back_to_menu' }
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

  let commentersText = `🏆 *Best Commenters*\n\n`;

  for (let i = 0; i < sortedUsers.length; i++) {
    const [userId, count] = sortedUsers[i];
    const user = await getUser(parseInt(userId));
    const userLevel = getUserLevel(count);
    
    commentersText += `${i + 1}. ${userLevel.symbol} ${user?.username || 'Anonymous'} (${count} comments)\n`;
  }

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🔍 View My Rank', callback_data: 'view_my_rank' }
        ],
        [
          { text: '📝 Add Comment', callback_data: 'add_comment' },
          { text: '🔙 Back to Menu', callback_data: 'back_to_menu' }
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

    usersText += `• ${levelInfo.symbol} ${name} (${reputation}⭐, ${followers} followers)\n`;
    usersText += `  ${bio}\n\n`;

    keyboard.push([
      { text: `👤 View ${name}`, callback_data: `view_profile_${user.telegramId}` }
    ]);
  }

  keyboard.push([{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]);

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
          { text: '📝 Send Confession', callback_data: 'send_confession' },
          { text: '📢 Promote Bot', callback_data: 'promote_bot' }
        ],
        [
          { text: '🔍 Browse Users', callback_data: 'browse_users' },
          { text: '🔙 Back to Menu', callback_data: 'back_to_menu' }
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
          { text: '📝 Send Confession', callback_data: 'send_confession' },
          { text: '📢 Promote Bot', callback_data: 'promote_bot' }
        ],
        [
          { text: '🔍 Browse Users', callback_data: 'browse_users' },
          { text: '🔙 Back to Menu', callback_data: 'back_to_menu' }
        ]
      ]
    }
  };

  await bot.sendMessage(chatId, text, { 
    parse_mode: 'Markdown',
    ...keyboard
  });
};

// ========== CONFESSION SUBMISSION ========== //
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
    await notifyAdmins(confessionId, sanitizedText, confessionNumber);

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📝 Send Another', callback_data: 'send_confession' },
            { text: '📢 Promote Bot', callback_data: 'promote_bot' }
          ],
          [
            { text: '🔙 Back to Menu', callback_data: 'back_to_menu' }
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
const notifyAdmins = async (confessionId, text, confessionNumber) => {
  const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(Number) : [];
  
  if (ADMIN_IDS.length === 0) {
    console.log('❌ No admin IDs configured in environment variables');
    return;
  }

  const previewText = text.length > 200 ? text.substring(0, 200) + '...' : text;
  const message = `🤫 *New Confession #${confessionNumber}*\n\n${previewText}\n\n*Actions:*`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: `approve_${confessionId}` },
          { text: '❌ Reject', callback_data: `reject_${confessionId}` }
        ]
      ]
    }
  };

  console.log(`📤 Notifying ${ADMIN_IDS.length} admins about confession ${confessionId}`);

  for (const adminId of ADMIN_IDS) {
    try {
      await bot.sendMessage(adminId, message, { 
        parse_mode: 'Markdown', 
        ...keyboard 
      });
    } catch (error) {
      console.error(`Admin notify error ${adminId}:`, error.message);
    }
  }
};

// ========== POST TO CHANNEL ========== //
const postToChannel = async (text, number, confessionId) => {
  const CHANNEL_ID = process.env.CHANNEL_ID;
  const BOT_USERNAME = process.env.BOT_USERNAME;
  
  if (!CHANNEL_ID) {
    console.error('❌ CHANNEL_ID not configured');
    return;
  }

  try {
    const message = `#${number}\n\n${text}\n\n💬 Comment on this confession:`;
    
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { 
              text: '👁️‍🗨️ View/Add Comments', 
              url: `https://t.me/${BOT_USERNAME}?start=comment_${confessionId}`
            }
          ]
        ]
      }
    };

    const sentMessage = await bot.sendMessage(CHANNEL_ID, message, keyboard);

    // Initialize comments collection
    await updateComment(confessionId, {
      confessionId: confessionId,
      confessionNumber: number,
      confessionText: text,
      comments: [],
      totalComments: 0,
      channelMessageId: sentMessage.message_id
    });
    
    console.log(`✅ Confession #${number} posted to channel`);
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
      await sendNotification(userId, message, 'newConfession');
    } else if (status === 'rejected') {
      message = `❌ *Confession Not Approved*\n\nReason: ${reason}\n\nYou can submit a new one.`;
      await sendNotification(userId, message, 'newConfession');
    }
  } catch (error) {
    console.error('User notify error:', error);
  }
};

// ========== VIEW COMMENTS ========== //
const handleViewComments = async (chatId, confessionId, page = 1) => {
  const commentData = await getComment(confessionId);
  
  if (!commentData || !commentData.confessionNumber) {
    await bot.sendMessage(chatId, '❌ Confession not found.');
    return;
  }

  const commentList = commentData.comments || [];
  const commentsPerPage = 3;
  const totalPages = Math.ceil(commentList.length / commentsPerPage);
  const startIndex = (page - 1) * commentsPerPage;
  const endIndex = startIndex + commentsPerPage;
  const pageComments = commentList.slice(startIndex, endIndex);

  let commentText = `💬 Comments for Confession #${commentData.confessionNumber}\n\n`;

  if (pageComments.length === 0) {
    commentText += 'No comments yet. Be the first to comment!\n\n';
  } else {
    commentText += `Comments (${startIndex + 1}-${Math.min(endIndex, commentList.length)} of ${commentList.length}):\n\n`;
    for (let i = 0; i < pageComments.length; i++) {
      const comment = pageComments[i];
      const user = await getUser(comment.userId);
      const userLevel = getUserLevel(await getCommentCount(comment.userId));
      
      commentText += `${startIndex + i + 1}. ${comment.text}\n`;
      commentText += `   - ${userLevel.symbol} ${user?.username || 'Anonymous'}\n\n`;
    }
  }

  const confession = await getConfession(confessionId);
  const author = confession ? await getUser(confession.userId) : null;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📝 Add Comment', callback_data: `add_comment_${confessionId}` }
        ]
      ]
    }
  };

  // Add follow button if author exists and is not current user
  if (author && author.telegramId !== chatId) {
    const currentUser = await getUser(chatId);
    const isFollowing = (currentUser?.following || []).includes(author.telegramId);
    keyboard.reply_markup.inline_keyboard[0].push(
      isFollowing 
        ? { text: '✅ Following', callback_data: `unfollow_${author.telegramId}` }
        : { text: '👤 Follow Author', callback_data: `follow_author_${confessionId}` }
    );
  }

  // Add pagination buttons if needed
  if (totalPages > 1) {
    const paginationRow = [];
    
    if (page > 1) {
      paginationRow.push({ text: '⬅️ Previous', callback_data: `comments_page_${confessionId}_${page - 1}` });
    }
    
    paginationRow.push({ text: `${page}/${totalPages}`, callback_data: `current_page` });
    
    if (page < totalPages) {
      paginationRow.push({ text: 'Next ➡️', callback_data: `comments_page_${confessionId}_${page + 1}` });
    }
    
    keyboard.reply_markup.inline_keyboard.push(paginationRow);
  }

  keyboard.reply_markup.inline_keyboard.push([
    { text: '🔙 Back to Menu', callback_data: 'back_to_menu' }
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
    userName: (await getUser(userId)).username || 'Anonymous',
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
  
  // Get confession author and send notification if enabled
  const confession = await getConfession(confessionId);
  if (confession && confession.userId !== userId) {
    await sendNotification(confession.userId,
      `💬 *New Comment on Your Confession*\n\nConfession #${confession.confessionNumber} has a new comment!\n\n"${sanitizedComment.substring(0, 50)}${sanitizedComment.length > 50 ? '...' : ''}"`,
      'newComment'
    );
  }
  
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
          { text: '👥 Manage Users', callback_data: 'manage_users' },
          { text: '📝 Review Confessions', callback_data: 'review_confessions' }
        ],
        [
          { text: '📊 Bot Statistics', callback_data: 'bot_stats' },
          { text: '❌ Block User', callback_data: 'block_user' }
        ],
        [
          { text: '✉️ Message User', callback_data: 'message_user' },
          { text: '📢 Broadcast', callback_data: 'broadcast_message' }
        ],
        [
          { text: '🔙 Main Menu', callback_data: 'back_to_menu' }
        ]
      ]
    }
  };

  await bot.sendMessage(chatId, fullText, { 
    parse_mode: 'Markdown',
    ...keyboard
  });
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

  try {
    await updateConfession(confessionId, {
      status: 'approved',
      approvedAt: new Date().toISOString()
    });

    // Update user reputation
    await updateUser(confession.userId, {
      reputation: admin.firestore.FieldValue.increment(10)
    });

    // Post to channel
    await postToChannel(confession.text, confession.confessionNumber, confessionId);
    
    // Notify user
    await notifyUser(confession.userId, confession.confessionNumber, 'approved');

    await bot.answerCallbackQuery(callbackQueryId, { text: '✅ Confession approved!' });
    
    // Send success message
    await bot.sendMessage(chatId, 
      `✅ *Confession #${confession.confessionNumber} Approved!*\n\nPosted to channel successfully.`
    );

  } catch (error) {
    console.error('Approve confession error:', error);
    await bot.answerCallbackQuery(callbackQueryId, { text: '❌ Error approving confession' });
  }
};

const handleRejectConfession = async (chatId, userId, confessionId, callbackQueryId) => {
  if (!isAdmin(userId)) {
    await bot.answerCallbackQuery(callbackQueryId, { text: '❌ Access denied' });
    return;
  }

  await setUserState(userId, {
    state: 'awaiting_rejection_reason',
    confessionId: confessionId
  });

  await bot.sendMessage(chatId, 
    `❌ *Rejecting Confession*\n\nPlease provide rejection reason:`
  );
  
  await bot.answerCallbackQuery(callbackQueryId, { text: 'Please provide rejection reason' });
};

const handleStartComment = async (chatId, confessionId, callbackQueryId) => {
  await setUserState(chatId, {
    state: 'awaiting_comment',
    confessionId: confessionId
  });

  await bot.sendMessage(chatId,
    `📝 *Add Comment*\n\nType your comment for this confession:`
  );
  
  await bot.answerCallbackQuery(callbackQueryId);
};

// ========== USER PROFILE VIEWING ========== //
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
  const username = `**Display Name:** ${targetUser.username}\n`;
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
    ],
    [{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]
  ];

  await bot.sendMessage(chatId, fullText, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
  
  await bot.answerCallbackQuery(callbackQueryId);
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
      { text: `🔍 View ${username}`, callback_data: `view_user_${userData.telegramId}` }
    ]);
  });
  
  keyboard.push([{ text: '🔙 Admin Menu', callback_data: 'admin_menu' }]);

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
    const username = user?.username ? `${user.username}` : `ID: ${conf.userId}`;
    
    confessionsText += `• From: ${username}\n`;
    confessionsText += `  Confession: "${conf.text.substring(0, 50)}${conf.text.length > 50 ? '...' : ''}"\n\n`;
  }

  const keyboard = [];

  for (const conf of confessionsList) {
    keyboard.push([
      { text: `✅ Approve #${conf.confessionNumber}`, callback_data: `approve_${conf.confessionId}` },
      { text: `❌ Reject #${conf.confessionNumber}`, callback_data: `reject_${conf.confessionId}` }
    ]);
  }

  keyboard.push([{ text: '🔙 Admin Menu', callback_data: 'admin_menu' }]);

  await bot.sendMessage(chatId, confessionsText, { 
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
};

// ========== BOT STATISTICS (ADMIN) ========== //
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
          { text: '📝 Review Confessions', callback_data: 'review_confessions' }
        ],
        [
          { text: '🔙 Admin Menu', callback_data: 'admin_menu' }
        ]
      ]
    }
  };

  await bot.sendMessage(chatId, fullText, { 
    parse_mode: 'Markdown',
    ...keyboard
  });
};

// ========== BLOCK USER (ADMIN) ========== //
const handleStartBlockUser = async (chatId, userId) => {
  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, '❌ Access denied');
    return;
  }

  await setUserState(userId, {
    state: 'awaiting_block_user',
    originalChatId: chatId
  });

  await bot.sendMessage(chatId, 
    `❌ *Block User*\n\nEnter user ID to block:`
  );
};

// ========== TOGGLE BLOCK USER (ADMIN) ========== //
const handleToggleBlockUser = async (chatId, adminId, targetUserId) => {
  if (!isAdmin(adminId)) {
    await bot.sendMessage(chatId, '❌ Access denied');
    return;
  }

  const user = await getUser(targetUserId);
  if (!user) {
    await bot.sendMessage(chatId, '❌ User not found');
    return;
  }

  const newStatus = !user.isActive;
  await updateUser(targetUserId, { isActive: newStatus });

  await bot.sendMessage(chatId, 
    `✅ User ${user.username || targetUserId} has been ${newStatus ? 'unblocked' : 'blocked'}.`
  );
};

// ========== VIEW USER DETAILS (ADMIN) ========== //
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
  const username = `**Username:** ${user.username}\n`;
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
        { text: user.isActive ? '❌ Block User' : '✅ Unblock User', callback_data: `toggle_block_${targetUserId}` }
      ],
      [
        { text: '🔙 Back to Users', callback_data: 'manage_users' }
      ]
    ]
  };

  await bot.sendMessage(chatId, fullText, { 
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
};

// ========== MESSAGE USER (ADMIN) ========== //
const handleStartMessageUser = async (chatId, userId) => {
  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, '❌ Access denied');
    return;
  }

  await setUserState(userId, {
    state: 'awaiting_message_user',
    originalChatId: chatId
  });

  await bot.sendMessage(chatId, 
    `✉️ *Message User*\n\nEnter user ID to message:`
  );
};

// ========== BROADCAST MESSAGE (ADMIN) ========== //
const handleBroadcastMessage = async (chatId, userId) => {
  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, '❌ Access denied');
    return;
  }

  await setUserState(userId, {
    state: 'awaiting_broadcast',
    originalChatId: chatId
  });

  await bot.sendMessage(chatId, 
    `📢 *Broadcast Message*\n\nEnter your broadcast message:`
  );
};

  // ========== CALLBACK QUERY HANDLER ========== //
  const handleCallbackQuery = async (callbackQuery) => {
    const message = callbackQuery.message;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;
    const chatId = message.chat.id;

    try {
      console.log(`📨 Callback received: ${data} from user ${userId}`);

      // Admin actions
      if (data.startsWith('approve_')) {
        const confessionId = data.replace('approve_', '');
        await handleApproveConfession(chatId, userId, confessionId, callbackQuery.id);
      } else if (data.startsWith('reject_')) {
        const confessionId = data.replace('reject_', '');
        await handleRejectConfession(chatId, userId, confessionId, callbackQuery.id);
      
      // Comment actions
      } else if (data.startsWith('add_comment_')) {
        const confessionId = data.replace('add_comment_', '');
        await handleStartComment(chatId, confessionId, callbackQuery.id);
      } else if (data.startsWith('comments_page_')) {
        const parts = data.split('_');
        const confessionId = parts[2];
        const page = parseInt(parts[3]);
        await handleViewComments(chatId, confessionId, page);
        await bot.answerCallbackQuery(callbackQuery.id);
      
      // User profile actions
      } else if (data.startsWith('view_profile_')) {
        const targetUserId = parseInt(data.replace('view_profile_', ''));
        await handleViewProfile(chatId, targetUserId, callbackQuery.id);
      } else if (data.startsWith('follow_')) {
        const targetUserId = parseInt(data.replace('follow_', ''));
        await handleFollowUser(chatId, userId, targetUserId);
        await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Followed user!' });
      } else if (data.startsWith('unfollow_')) {
        const targetUserId = parseInt(data.replace('unfollow_', ''));
        await handleUnfollowUser(chatId, userId, targetUserId);
        await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Unfollowed user!' });
      } else if (data.startsWith('follow_author_')) {
        const confessionId = data.replace('follow_author_', '');
        const confession = await getConfession(confessionId);
        if (confession) {
          await handleFollowUser(chatId, userId, confession.userId);
          await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Followed author!' });
        }
      
      // Admin user management
      } else if (data.startsWith('view_user_')) {
        const targetUserId = parseInt(data.replace('view_user_', ''));
        await handleViewUser(chatId, userId, targetUserId);
        await bot.answerCallbackQuery(callbackQuery.id);
      } else if (data.startsWith('toggle_block_')) {
        const targetUserId = parseInt(data.replace('toggle_block_', ''));
        await handleToggleBlockUser(chatId, userId, targetUserId);
        await bot.answerCallbackQuery(callbackQuery.id);
      
      // Main menu actions
      } else if (data === 'send_confession') {
        await handleSendConfession({ chat: { id: chatId }, from: { id: userId } });
        await bot.answerCallbackQuery(callbackQuery.id);
      } else if (data === 'my_profile') {
        await handleMyProfile({ chat: { id: chatId }, from: { id: userId } });
        await bot.answerCallbackQuery(callbackQuery.id);
      } else if (data === 'promote_bot') {
        await handlePromoteBot({ chat: { id: chatId }, from: { id: userId } });
        await bot.answerCallbackQuery(callbackQuery.id);
      } else if (data === 'back_to_menu') {
        await showMainMenu(chatId);
        await bot.answerCallbackQuery(callbackQuery.id);
      
      // Profile management
      } else if (data === 'set_username') {
        await handleStartSetUsername(chatId, userId);
        await bot.answerCallbackQuery(callbackQuery.id);
      } else if (data === 'set_bio') {
        await handleStartSetBio(chatId, userId);
        await bot.answerCallbackQuery(callbackQuery.id);
      } else if (data === 'show_followers') {
        await handleShowFollowers({ chat: { id: chatId }, from: { id: userId } });
        await bot.answerCallbackQuery(callbackQuery.id);
      } else if (data === 'show_following') {
        await handleShowFollowing({ chat: { id: chatId }, from: { id: userId } });
        await bot.answerCallbackQuery(callbackQuery.id);
      } else if (data === 'my_confessions') {
        await handleMyConfessions(chatId, userId);
        await bot.answerCallbackQuery(callbackQuery.id);
      
      // Settings
      } else if (data === 'comment_settings') {
        await handleCommentSettings(chatId, userId);
        await bot.answerCallbackQuery(callbackQuery.id);
      } else if (data === 'notification_settings') {
        await handleNotificationSettings(chatId, userId);
        await bot.answerCallbackQuery(callbackQuery.id);
      
      // Rankings and achievements
      } else if (data === 'view_rankings') {
        await handleBestCommenters({ chat: { id: chatId }, from: { id: userId } });
        await bot.answerCallbackQuery(callbackQuery.id);
      } else if (data === 'view_my_rank') {
        await handleViewMyRank(chatId, userId);
        await bot.answerCallbackQuery(callbackQuery.id);
      } else if (data === 'view_achievements') {
        await handleAchievements({ chat: { id: chatId }, from: { id: userId } });
        await bot.answerCallbackQuery(callbackQuery.id);
      
      // Browse users
      } else if (data === 'browse_users') {
        await handleBrowseUsers({ chat: { id: chatId }, from: { id: userId } });
        await bot.answerCallbackQuery(callbackQuery.id);
      
      // Admin panel
      } else if (data === 'admin_menu') {
        await handleAdmin({ chat: { id: chatId }, from: { id: userId } });
        await bot.answerCallbackQuery(callbackQuery.id);
      } else if (data === 'manage_users') {
        await handleManageUsers(chatId, userId);
        await bot.answerCallbackQuery(callbackQuery.id);
      } else if (data === 'review_confessions') {
        await handleReviewConfessions(chatId, userId);
        await bot.answerCallbackQuery(callbackQuery.id);
      } else if (data === 'bot_stats') {
        await handleBotStats(chatId, userId);
        await bot.answerCallbackQuery(callbackQuery.id);
      } else if (data === 'block_user') {
        await handleStartBlockUser(chatId, userId);
        await bot.answerCallbackQuery(callbackQuery.id);
      } else if (data === 'message_user') {
        await handleStartMessageUser(chatId, userId);
        await bot.answerCallbackQuery(callbackQuery.id);
      } else if (data === 'broadcast_message') {
        await handleBroadcastMessage(chatId, userId);
        await bot.answerCallbackQuery(callbackQuery.id);
      
      // Notification settings
      } else if (data === 'toggle_follower_notif') {
        const newState = await toggleNotification(userId, 'newFollower');
        await bot.answerCallbackQuery(callbackQuery.id, { text: `New Followers: ${newState ? 'ON' : 'OFF'}` });
        await handleNotificationSettings(chatId, userId);
      } else if (data === 'toggle_comment_notif') {
        const newState = await toggleNotification(userId, 'newComment');
        await bot.answerCallbackQuery(callbackQuery.id, { text: `New Comments: ${newState ? 'ON' : 'OFF'}` });
        await handleNotificationSettings(chatId, userId);
      } else if (data === 'toggle_confession_notif') {
        const newState = await toggleNotification(userId, 'newConfession');
        await bot.answerCallbackQuery(callbackQuery.id, { text: `New Confessions: ${newState ? 'ON' : 'OFF'}` });
        await handleNotificationSettings(chatId, userId);
      } else if (data === 'toggle_dm_notif') {
        const newState = await toggleNotification(userId, 'directMessage');
        await bot.answerCallbackQuery(callbackQuery.id, { text: `Direct Messages: ${newState ? 'ON' : 'OFF'}` });
        await handleNotificationSettings(chatId, userId);
      } else if (data === 'save_notifications') {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Settings saved!' });
      
      // Comment settings
      } else if (data === 'comment_everyone') {
        await updateUser(userId, { 'commentSettings.allowComments': 'everyone' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Comments set to Everyone' });
        await handleCommentSettings(chatId, userId);
      } else if (data === 'comment_followers') {
        await updateUser(userId, { 'commentSettings.allowComments': 'followers' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Comments set to Followers Only' });
        await handleCommentSettings(chatId, userId);
      } else if (data === 'comment_anon') {
        const user = await getUser(userId);
        const current = user.commentSettings?.allowAnonymous ?? true;
        await updateUser(userId, { 'commentSettings.allowAnonymous': !current });
        await bot.answerCallbackQuery(callbackQuery.id, { text: `✅ Anonymous comments ${!current ? 'enabled' : 'disabled'}` });
        await handleCommentSettings(chatId, userId);
      } else if (data === 'comment_approve') {
        const user = await getUser(userId);
        const current = user.commentSettings?.requireApproval ?? false;
        await updateUser(userId, { 'commentSettings.requireApproval': !current });
        await bot.answerCallbackQuery(callbackQuery.id, { text: `✅ Comment approval ${!current ? 'enabled' : 'disabled'}` });
        await handleCommentSettings(chatId, userId);
      
      // Default case - answer callback to remove loading state
      } else {
        await bot.answerCallbackQuery(callbackQuery.id);
      }

    } catch (error) {
      console.error('Callback error:', error);
      await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Error processing request' });
    }
  };

  // ========== MESSAGE HANDLER ========== //
  const handleMessage = async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    if (!text) return;

    const userState = await getUserState(userId);
    
    // Handle user states
    if (userState) {
      if (userState.state === 'awaiting_username') {
        if (text.length < 3 || text.length > 20 || !/^[a-zA-Z0-9_]+$/.test(text)) {
          await bot.sendMessage(chatId, '❌ Invalid username. Use 3-20 characters (letters, numbers, underscores only).');
          return;
        }

        // Check if username already exists (excluding 'Anonymous')
        if (text.toLowerCase() !== 'anonymous') {
          const usersSnapshot = await db.collection('users').where('username', '==', text).limit(1).get();
          if (!usersSnapshot.empty && usersSnapshot.docs[0].data().telegramId !== userId) {
            await bot.sendMessage(chatId, '❌ Username already taken. Choose another one.');
            return;
          }
        }

        await updateUser(userId, { username: text });
        await clearUserState(userId);
        
        await bot.sendMessage(chatId, `✅ Display name updated to ${text}!`);
        await showMainMenu(chatId);
        return;
      }

      if (userState.state === 'awaiting_confession') {
        await handleConfessionSubmission(msg, text);
        await clearUserState(userId);
        return;
      }

      if (userState.state === 'awaiting_comment') {
        await handleAddComment(chatId, userState.confessionId, text);
        await clearUserState(userId);
        return;
      }

      if (userState.state === 'awaiting_bio') {
        if (text.length > 100) {
          await bot.sendMessage(chatId, '❌ Bio too long. Maximum 100 characters.');
          return;
        }

        await updateUser(userId, { bio: text });
        await clearUserState(userId);
        await bot.sendMessage(chatId, '✅ Bio updated successfully!');
        return;
      }

      if (userState.state === 'awaiting_rejection_reason' && isAdmin(userId)) {
        const confessionId = userState.confessionId;
        const confession = await getConfession(confessionId);
        
        if (confession) {
          await updateConfession(confessionId, {
            status: 'rejected',
            rejectionReason: text
          });

          await notifyUser(confession.userId, confession.confessionNumber, 'rejected', text);
          
          await bot.sendMessage(chatId, `✅ Confession rejected.`);
        }
        await clearUserState(userId);
        return;
      }

      if (userState.state === 'awaiting_block_user' && isAdmin(userId)) {
        const targetUserId = parseInt(text);
        if (isNaN(targetUserId)) {
          await bot.sendMessage(chatId, '❌ Invalid user ID. Please enter a numeric user ID.');
          return;
        }

        const user = await getUser(targetUserId);
        if (!user) {
          await bot.sendMessage(chatId, '❌ User not found.');
          await clearUserState(userId);
          return;
        }

        await updateUser(targetUserId, { isActive: false });
        await clearUserState(userId);
        await bot.sendMessage(chatId, `✅ User ${user.username || targetUserId} has been blocked.`);
        return;
      }

      if (userState.state === 'awaiting_message_user' && isAdmin(userId)) {
        const targetUserId = parseInt(text);
        if (isNaN(targetUserId)) {
          await bot.sendMessage(chatId, '❌ Invalid user ID. Please enter a numeric user ID.');
          return;
        }

        await setUserState(userId, {
          state: 'awaiting_message_content',
          targetUserId: targetUserId
        });

        await bot.sendMessage(chatId, `✉️ Now enter your message for user ${targetUserId}:`);
        return;
      }

      if (userState.state === 'awaiting_message_content' && isAdmin(userId)) {
        const targetUserId = userState.targetUserId;
        try {
          await bot.sendMessage(targetUserId, 
            `📨 *Message from Admin*\n\n${text}`
          );
          await bot.sendMessage(chatId, `✅ Message sent to user ${targetUserId}`);
        } catch (error) {
          await bot.sendMessage(chatId, `❌ Failed to send message to user ${targetUserId}`);
        }
        await clearUserState(userId);
        return;
      }

      if (userState.state === 'awaiting_broadcast' && isAdmin(userId)) {
        const usersSnapshot = await db.collection('users').get();
        let successCount = 0;
        let failCount = 0;

        for (const doc of usersSnapshot.docs) {
          const user = doc.data();
          if (user.isActive && user.telegramId) {
            try {
              await bot.sendMessage(user.telegramId, 
                `📢 *Broadcast Message*\n\n${text}`
              );
              successCount++;
            } catch (error) {
              failCount++;
            }
          }
        }

        await clearUserState(userId);
        await bot.sendMessage(chatId, 
          `✅ Broadcast completed!\n\n` +
          `✅ Success: ${successCount} users\n` +
          `❌ Failed: ${failCount} users`
        );
        return;
      }
    }

    // Handle commands and menu buttons
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

  // ========== MISSING FUNCTION IMPLEMENTATIONS ========== //
  
  // ACHIEVEMENTS
  const handleAchievements = async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const user = await getUser(userId);

    const achievements = user.achievements || [];
    
    if (achievements.length === 0) {
      await bot.sendMessage(chatId, 
        `🏆 *Your Achievements*\n\nNo achievements yet. Keep using the bot to earn achievements!\n\nEarn achievements by:\n• Submitting confessions\n• Commenting on posts\n• Gaining followers\n• Building reputation`
      );
      return;
    }

    let achievementsText = `🏆 *Your Achievements*\n\n`;
    
    achievements.forEach((achievement, index) => {
      achievementsText += `${index + 1}. ${achievement}\n`;
    });

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔙 Back to Profile', callback_data: 'my_profile' }
          ]
        ]
      }
    };

    await bot.sendMessage(chatId, achievementsText, { 
      parse_mode: 'Markdown',
      ...keyboard
    });
  };

  // SETTINGS
  const handleSettings = async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    await bot.sendMessage(chatId, 
      `⚙️ *Settings*\n\nManage your bot preferences and privacy settings.`,
      { 
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔔 Notifications', callback_data: 'notification_settings' },
              { text: '📝 Profile', callback_data: 'my_profile' }
            ],
            [
              { text: '🔒 Comments', callback_data: 'comment_settings' },
              { text: '🏆 Achievements', callback_data: 'view_achievements' }
            ],
            [
              { text: '🔙 Back to Menu', callback_data: 'back_to_menu' }
            ]
          ]
        }
      }
    );
  };

  // FOLLOW/UNFOLLOW FUNCTIONS
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

    // Check if already following
    if ((currentUser.following || []).includes(targetUserId)) {
      await bot.sendMessage(chatId, `❌ You are already following ${targetUser.username || 'this user'}!`);
      return;
    }

    const currentFollowing = [...(currentUser.following || []), targetUserId];
    const targetFollowers = [...(targetUser.followers || []), userId];
    
    await updateUser(userId, { following: currentFollowing });
    await updateUser(targetUserId, { followers: targetFollowers });

    await bot.sendMessage(chatId, `✅ Following ${targetUser.username || 'User'}!`);

    // Send notification to target user
    await sendNotification(targetUserId, 
      `🎉 *New Follower!*\n\n${currentUser.username || 'Someone'} is now following you!`, 
      'newFollower'
    );
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

    await bot.sendMessage(chatId, `❌ Unfollowed ${targetUser.username || 'User'}`);
  };

  // PROFILE MANAGEMENT
  const handleStartSetUsername = async (chatId, userId) => {
    await setUserState(userId, {
      state: 'awaiting_username',
      originalChatId: chatId
    });

    await bot.sendMessage(chatId, 
      `📝 *Set Display Name*\n\nEnter your desired display name:\n\nMust be 3-20 characters, letters/numbers/underscores only.`
    );
  };

  const handleStartSetBio = async (chatId, userId) => {
    await setUserState(userId, {
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
        `👥 *Your Followers*\n\nNo followers yet. Share your profile to get followers!`
      );
      return;
    }

    let followersText = `👥 *Your Followers (${followers.length})*\n\n`;
    
    for (const followerId of followers.slice(0, 20)) { // Limit to 20
      const follower = await getUser(followerId);
      const name = follower?.username || 'Anonymous';
      const commentCount = await getCommentCount(followerId);
      const levelInfo = getUserLevel(commentCount);
      followersText += `• ${levelInfo.symbol} ${name}\n`;
    }

    if (followers.length > 20) {
      followersText += `\n... and ${followers.length - 20} more followers`;
    }

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔍 Browse Users', callback_data: 'browse_users' },
            { text: '🔙 Back to Profile', callback_data: 'my_profile' }
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
        `👥 *You're Following*\n\nNot following anyone yet. Browse users to find people to follow!`
      );
      return;
    }

    let followingText = `👥 *You're Following (${following.length})*\n\n`;
    
    for (const followingId of following.slice(0, 20)) { // Limit to 20
      const followee = await getUser(followingId);
      const name = followee?.username || 'Anonymous';
      const commentCount = await getCommentCount(followingId);
      const levelInfo = getUserLevel(commentCount);
      followingText += `• ${levelInfo.symbol} ${name}\n`;
    }

    if (following.length > 20) {
      followingText += `\n... and ${following.length - 20} more users`;
    }

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔍 Browse Users', callback_data: 'browse_users' },
            { text: '🔙 Back to Profile', callback_data: 'my_profile' }
          ]
        ]
      }
    };

    await bot.sendMessage(chatId, followingText, { 
      parse_mode: 'Markdown',
      ...keyboard
    });
  };

  // NOTIFICATION SETTINGS
  const handleNotificationSettings = async (chatId, userId) => {
    const user = await getUser(userId);
    const notifications = user.notifications || {
      newFollower: true,
      newComment: true,
      newConfession: true,
      directMessage: true
    };
    
    let settingsText = `🔔 *Notification Settings*\n\n`;
    settingsText += `🔔 New Followers: ${notifications.newFollower ? '✅ ON' : '❌ OFF'}\n`;
    settingsText += `💬 New Comments: ${notifications.newComment ? '✅ ON' : '❌ OFF'}\n`;
    settingsText += `📝 New Confessions: ${notifications.newConfession ? '✅ ON' : '❌ OFF'}\n`;
    settingsText += `✉️ Direct Messages: ${notifications.directMessage ? '✅ ON' : '❌ OFF'}\n\n`;
    settingsText += `Tap buttons to toggle settings:`;

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: notifications.newFollower ? '✅ Followers' : '❌ Followers', callback_data: 'toggle_follower_notif' },
            { text: notifications.newComment ? '✅ Comments' : '❌ Comments', callback_data: 'toggle_comment_notif' }
          ],
          [
            { text: notifications.newConfession ? '✅ Confessions' : '❌ Confessions', callback_data: 'toggle_confession_notif' },
            { text: notifications.directMessage ? '✅ Messages' : '❌ Messages', callback_data: 'toggle_dm_notif' }
          ],
          [
            { text: '💾 Save', callback_data: 'save_notifications' },
            { text: '🔙 Back', callback_data: 'settings_menu' }
          ]
        ]
      }
    };

    await bot.sendMessage(chatId, settingsText, { 
      parse_mode: 'Markdown',
      ...keyboard
    });
  };

  // TOGGLE NOTIFICATIONS
  const toggleNotification = async (userId, settingName) => {
    const user = await getUser(userId);
    const currentSetting = user.notifications?.[settingName] ?? true;
    const newSetting = !currentSetting;
    
    await updateUser(userId, {
      [`notifications.${settingName}`]: newSetting
    });
    
    return newSetting;
  };

  // COMMENT SETTINGS
  const handleCommentSettings = async (chatId, userId) => {
    const user = await getUser(userId);
    
    const settings = user.commentSettings || {};
    
    let settingsText = `🔒 *Comment Settings*\n\n`;
    settingsText += `Who can comment on your confessions:\n`;
    settingsText += `• ${settings.allowComments === 'everyone' ? '✅' : '❌'} Everyone\n`;
    settingsText += `• ${settings.allowComments === 'followers' ? '✅' : '❌'} Followers Only\n`;
    settingsText += `• ${settings.allowComments === 'admin' ? '✅' : '❌'} Admin Only\n\n`;
    settingsText += `Allow anonymous comments: ${settings.allowAnonymous ? '✅ Yes' : '❌ No'}\n`;
    settingsText += `Require comment approval: ${settings.requireApproval ? '✅ Yes' : '❌ No'}\n`;

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: settings.allowComments === 'everyone' ? '✅ Everyone' : '❌ Everyone', callback_data: 'comment_everyone' },
            { text: settings.allowComments === 'followers' ? '✅ Followers' : '❌ Followers', callback_data: 'comment_followers' }
          ],
          [
            { text: settings.allowAnonymous ? '✅ Anonymous' : '❌ Anonymous', callback_data: 'comment_anon' },
            { text: settings.requireApproval ? '✅ Approval' : '❌ Approval', callback_data: 'comment_approve' }
          ],
          [
            { text: '💾 Save', callback_data: 'save_comment_settings' },
            { text: '🔙 Back to Profile', callback_data: 'my_profile' }
          ]
        ]
      }
    };

    await bot.sendMessage(chatId, settingsText, { 
      parse_mode: 'Markdown',
      ...keyboard
    });
  };

  // VIEW MY RANK
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
    rankText += `Total Comments: ${commentCount}\n`;
    rankText += `Rank: #${userRank} of ${sortedUsers.length} users\n\n`;
    rankText += `Keep commenting to climb the leaderboard!`;

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📝 Add Comment', callback_data: 'add_comment' },
            { text: '🏆 View Rankings', callback_data: 'view_rankings' }
          ],
          [
            { text: '🔙 Back to Menu', callback_data: 'back_to_menu' }
          ]
        ]
      }
    };

    await bot.sendMessage(chatId, rankText, { 
      parse_mode: 'Markdown',
      ...keyboard
    });
  };

  // HELP COMMAND
  const handleHelp = async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const adminStatus = isAdmin(userId);

    let helpMessage = `ℹ️ *JU Confession Bot Help*\n\n` +
      `*How to Use:*\n` +
      `1. Click "📝 Send Confession" to submit anonymously\n` +
      `2. Wait for admin approval\n` +
      `3. View approved confessions in channel\n` +
      `4. Comment on confessions and build reputation\n\n` +
      `*Main Features:*\n` +
      `• Anonymous confession submission\n` +
      `• User profiles with display names\n` +
      `• Follow/unfollow system\n` +
      `• Comment and reputation system\n` +
      `• Achievement tracking\n` +
      `• User levels and rankings\n\n` +
      `*Commands:*\n` +
      `/start - Start the bot\n` +
      `/help - Show this help\n`;

    if (adminStatus) {
      helpMessage += `\n*⚡ Admin Commands:*\n` +
        `/admin - Admin panel\n`;
    }

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📝 Send Confession', callback_data: 'send_confession' },
            { text: '👤 My Profile', callback_data: 'my_profile' }
          ],
          [
            { text: '🔙 Back to Menu', callback_data: 'back_to_menu' }
          ]
        ]
      }
    };

    await bot.sendMessage(chatId, helpMessage, { 
      parse_mode: 'Markdown',
      ...keyboard
    });
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
        timestamp: new Date().toISOString()
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
  console.log('🚀 All features are ready to use!');
} catch (error) {
  console.error('Firebase initialization error:', error);
      }
