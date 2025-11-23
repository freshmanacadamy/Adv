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

  async function updateConfession(confessionId, updateData) {
    await db.collection('confessions').doc(confessionId).update(updateData);
  }

  async function createConfession(confessionData) {
    await db.collection('confessions').doc(confessionData.confessionId).set(confessionData);
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
      
      if (!doc.exists) {
        transaction.set(counterRef, {
          value: 1
        });
        return 1;
      }
      
      const current = doc.data().value;
      const next = current + 1;
      
      transaction.update(counterRef, {
        value: next
      });
      
      return next;
    });
    return result;
  }

  // ========== STATE MANAGEMENT ========== //
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
      
      if (notifications[settingName] !== false) { // Default is true
        await bot.sendMessage(userId, message, { parse_mode: 'Markdown' });
      }
    } catch (error) {
      console.error('Notification error:', error);
    }
  }

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
      
      await bot.sendMessage(CHANNEL_ID, message, {
        reply_markup: {
          inline_keyboard: [
            [
              { 
                text: '👁️‍🗨️ View/Add Comments', 
                url: `https://t.me/${BOT_USERNAME}?start=comments_${confessionId}`
              }
            ]
          ]
        }
      });

      // Initialize comments collection
      await updateComment(confessionId, {
        confessionId: confessionId,
        confessionNumber: number,
        confessionText: text,
        comments: [],
        totalComments: 0
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
      } else {
        message = `❌ *Confession Not Approved*\n\nReason: ${reason}\n\nYou can submit a new one.`;
        await sendNotification(userId, message, 'newConfession');
      }
    } catch (error) {
      console.error('User notify error:', error);
    }
  };

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
          [{ text: '🔥 Trending' }, { text: '🎯 Daily Check-in' }],
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
    
    // Check if user is blocked (isActive = false)
    if (user.isActive === false) {
      await bot.sendMessage(chatId, '❌ Your account has been blocked by admin.');
      return;
    }

    // If user doesn't have a username, prompt them to set one
    if (!user.username || user.username === 'Anonymous') {
      await bot.sendMessage(chatId,
        `🤫 *Welcome to JU Confession Bot!*\n\n` +
        `First, please set your display name (without $ symbol):\n\n` +
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

  // ========== DAILY CHECKIN ========== //
  const handleCheckin = async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const user = await getUser(userId);

    if (!user) {
      await bot.sendMessage(chatId, '❌ Please start the bot first with /start');
      return;
    }

    const today = new Date().toDateString();
    const lastCheckin = user.lastCheckin ? new Date(user.lastCheckin).toDateString() : null;

    if (lastCheckin === today) {
      await bot.sendMessage(chatId, 
        `✅ You already checked in today!\n\nCurrent streak: ${user.dailyStreak} days`
      );
      return;
    }

    let newStreak = 1;
    if (lastCheckin) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      
      if (lastCheckin === yesterday.toDateString()) {
        newStreak = user.dailyStreak + 1;
      }
    }

    user.dailyStreak = newStreak;
    user.lastCheckin = new Date().toISOString();
    user.reputation = (user.reputation || 0) + 2;
    users.set(userId, user);

    await bot.sendMessage(chatId, 
      `🎉 Daily Check-in!\n\n✅ +2 reputation points\nCurrent streak: ${newStreak} days`
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
      state: 'awaiting_confession',
      confessionData: {}
    });

    await bot.sendMessage(chatId,
      `✍️ *Send Your Confession*\n\nType your confession below (max 1000 characters):\n\nYou can add hashtags like #love #study #funny`,
      { parse_mode: 'Markdown' }
    );
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
      await notifyAdmins(confessionId, sanitizedText, confessionNumber);

      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📝 Send Another', callback_data: 'send_confession' },
              { text: '🎯 Daily Check-in', callback_ 'daily_checkin' }
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

  // ========== VIEW PROFILE ========== //
  const handleMyProfile = async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const user = await getUser(userId);

    const commentCount = await getCommentCount(userId);
    const levelInfo = getUserLevel(commentCount);

    const profileText = `👤 *My Profile*\n\n`;
    const username = user.username ? `**Username:** ${user.username}\n` : `**Username:** Not set\n`;
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

    let commentersText = `🏆 *Best Commenters - Weekly*\n\n`;

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
            { text: '🔄 Weekly', callback_data: 'best_commenters_weekly' },
            { text: '📅 Monthly', callback_data: 'best_commenters_monthly' }
          ],
          [
            { text: '📈 All Time', callback_data: 'best_commenters_all' },
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
            { text: '🎯 Daily Check-in', callback_data: 'daily_checkin' }
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

  // ========== SETTINGS ========== //
  const handleSettings = async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    await bot.sendMessage(chatId, 
      `⚙️ *Settings*\n\n` +
      `• Username: Set in profile\n` +
      `• Bio: Set in profile\n` +
      `• Achievement tracking\n` +
      `• 🔔 Notification Settings\n\n` +
      `Current features:`,
      { 
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔔 Notification Settings', callback_data: 'notification_settings' },
              { text: '📝 Profile Settings', callback_data: 'profile_settings' }
            ],
            [
              { text: '🔒 Privacy Settings', callback_data: 'privacy_settings' },
              { text: '🏆 Achievement Settings', callback_data: 'achievement_settings' }
            ],
            [
              { text: '🔍 Browse Settings', callback_data: 'browse_settings' },
              { text: '🔙 Back to Menu', callback_data: 'back_to_menu' }
            ]
          ]
        }
      }
    );
  };

  // ========== ADMIN COMMAND ========== //
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
            { text: '💬 Monitor Chats', callback_data: 'monitor_chats' },
            { text: '👤 Add Admin', callback_data: 'add_admin' }
          ],
          [
            { text: '🔧 Maintenance Mode', callback_data: 'toggle_maintenance' },
            { text: '✉️ Message User', callback_data: 'message_user' }
          ],
          [
            { text: '📢 Broadcast Message', callback_data: 'broadcast_message' },
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

  // ========== HELP COMMAND ========== //
  const handleHelp = async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const isAdmin = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(Number).includes(userId) : false;

    let helpMessage = `ℹ️ *JU Confession Bot Help*\n\n` +
      `*How to Confess:*\n` +
      `1. Click "📝 Send Confession"\n` +
      `2. Type your confession\n` +
      `3. Wait for admin approval\n` +
      `4. See it posted in the channel\n\n` +
      `*Features:*\n` +
      `• Anonymous confessions\n` +
      `• User profiles with display names\n` +
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
        commentText += `   - ${userLevel.symbol} ${user?.username || 'Anonymous'}\n\n`;
      }
    }

    const confession = await getConfession(confessionId);
    const author = await getUser(confession?.userId);

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📝 Add Comment', callback_data: `add_comment_${confessionId}` },
            { text: author ? `👤 Follow ${author.username}` : '👤 Follow Author', callback_data: `follow_author_${confessionId}` }
          ]
        ]
      }
    };

    // Add pagination buttons if needed
    if (totalPages > 1) {
      const paginationRow = [];
      
      if (page > 1) {
        paginationRow.push({ text: '⬅️ Previous', callback_data: `comments_page_${confessionId}_${page - 1}` });
      }
      
      paginationRow.push({ text: `${page}/${totalPages}`, callback_data: `comments_page_${confessionId}_${page}` });
      
      if (page < totalPages) {
        paginationRow.push({ text: 'Next ➡️', callback_data: `comments_page_${confessionId}_${page + 1}` });
      }
      
      keyboard.reply_markup.inline_keyboard.push(paginationRow);
    }

    keyboard.reply_markup.inline_keyboard.push([
      { text: '👤 View Profile', callback_data: 'view_profile' },
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
    
    // Get confession author and send notification if enabled
    const confession = await getConfession(confessionId);
    if (confession && confession.userId !== userId) { // Don't notify if user comments on own confession
      await sendNotification(confession.userId,
        `💬 *New Comment on Your Confession*\n\nConfession #${confession.confessionNumber} has a new comment!\n\n"${sanitizedComment.substring(0, 50)}${sanitizedComment.length > 50 ? '...' : ''}"`,
        'newComment'
      );
    }
    
    await handleViewComments(chatId, confessionId);
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
      } else if (data === 'notification_settings') {
        await handleNotificationSettings(chatId, userId);
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
      
      // Send success message instead of editing (which might fail)
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
    await setUserState(chatId, {
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
    const username = targetUser.username ? `**Username:** ${targetUser.username}\n` : '';
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
    keyboard.push([{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]);

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

  // ========== MESSAGE HANDLER ========== //
  const handleMessage = async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    if (!text) return;

    const userState = await getUserState(userId);
    
    if (userState && userState.state === 'awaiting_username') {
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

    if (userState && userState.state === 'awaiting_confession') {
      await handleConfessionSubmission(msg, text);
      await clearUserState(userId);
      return;
    }

    if (userState && userState.state === 'awaiting_comment') {
      await handleAddComment(chatId, userState.confessionId, text);
      await clearUserState(userId);
      return;
    }

    if (userState && userState.state === 'awaiting_bio') {
      if (text.length > 100) {
        await bot.sendMessage(chatId, '❌ Bio too long. Maximum 100 characters.');
        return;
      }

      await updateUser(userId, { bio: text });
      await clearUserState(userId);
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
      await clearUserState(userId);
      return;
    }

    if (text.startsWith('/')) {
      switch (text) {
        case '/start':
          await handleStart(msg);
          break;
        case '/checkin':
          await handleCheckin(msg);
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
        case '🎯 Daily Check-in':
          await handleCheckin(msg);
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
    // Set CORS headers
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
} catch (error) {
  console.error('Firebase initialization error:', error);
        }
