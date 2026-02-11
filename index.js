// ===================== НАСТРОЙКА =====================
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Настройка загрузки файлов
const storage = multer.diskStorage({
  destination: 'public/uploads/',
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// Настройка почты для жалоб
const mailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.ADMIN_EMAIL,
    pass: process.env.ADMIN_EMAIL_PASSWORD
  }
});

// База данных SQLite
const db = new sqlite3.Database('spectr.db');

// Создание таблиц
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      googleId TEXT UNIQUE,
      email TEXT UNIQUE,
      name TEXT,
      avatar TEXT,
      isAdmin INTEGER DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT,
      contactId TEXT,
      nickname TEXT,
      FOREIGN KEY (userId) REFERENCES users (id),
      FOREIGN KEY (contactId) REFERENCES users (id)
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT, -- 'private', 'group', 'channel'
      name TEXT,
      avatar TEXT,
      createdBy TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS chat_members (
      chatId INTEGER,
      userId TEXT,
      role TEXT DEFAULT 'member', -- 'member', 'admin', 'owner'
      joinedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chatId) REFERENCES chats (id),
      FOREIGN KEY (userId) REFERENCES users (id)
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatId INTEGER,
      userId TEXT,
      type TEXT DEFAULT 'text', -- 'text', 'image', 'video', 'file'
      content TEXT,
      fileUrl TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chatId) REFERENCES chats (id),
      FOREIGN KEY (userId) REFERENCES users (id)
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporterId TEXT,
      reportedUserId TEXT,
      chatId INTEGER,
      reason TEXT,
      status TEXT DEFAULT 'pending',
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (reporterId) REFERENCES users (id),
      FOREIGN KEY (reportedUserId) REFERENCES users (id)
    )
  `);
});

// ===================== ПАСПОРТ =====================
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.DOMAIN + '/auth/google/callback'
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      // Сохраняем пользователя в БД
      db.get('SELECT * FROM users WHERE googleId = ?', [profile.id], (err, user) => {
        if (!user) {
          db.run(
            'INSERT INTO users (id, googleId, email, name, avatar, isAdmin) VALUES (?, ?, ?, ?, ?, ?)',
            [Date.now().toString(), profile.id, profile.emails[0].value, profile.displayName, profile.photos[0].value, 0]
          );
        }
        done(null, profile);
      });
    } catch (error) {
      done(error);
    }
  }
));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ===================== MIDDLEWARE =====================
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: true
}));
app.use(passport.initialize());
app.use(passport.session());

// ===================== РОУТЫ =====================

// Главная страница
app.get('/', (req, res) => {
  if (req.isAuthenticated()) {
    res.sendFile(__dirname + '/views/dashboard.html');
  } else {
    res.sendFile(__dirname + '/views/login.html');
  }
});

// Google OAuth
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.get('/logout', (req, res) => { req.logout(() => res.redirect('/')); });

// API для получения данных
app.get('/api/user', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  res.json(req.user);
});

app.get('/api/contacts', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  
  db.all(`
    SELECT u.*, c.nickname 
    FROM contacts c 
    JOIN users u ON c.contactId = u.googleId 
    WHERE c.userId = ?
  `, [req.user.id], (err, contacts) => {
    res.json(contacts || []);
  });
});

app.get('/api/chats', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  
  db.all(`
    SELECT c.*, cm.role 
    FROM chats c
    JOIN chat_members cm ON c.id = cm.chatId
    WHERE cm.userId = ?
    ORDER BY c.createdAt DESC
  `, [req.user.id], (err, chats) => {
    res.json(chats || []);
  });
});

// Добавление контакта
app.post('/api/contacts/add', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  
  const { email, nickname } = req.body;
  
  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    db.run(
      'INSERT INTO contacts (userId, contactId, nickname) VALUES (?, ?, ?)',
      [req.user.id, user.googleId, nickname || user.name]
    );
    
    res.json({ success: true, user });
  });
});

// Создание группового чата
app.post('/api/chats/create-group', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  
  const { name, userIds } = req.body;
  const chatId = Date.now();
  
  db.run(
    'INSERT INTO chats (id, type, name, createdBy) VALUES (?, ?, ?, ?)',
    [chatId, 'group', name, req.user.id],
    function() {
      // Добавляем создателя как владельца
      db.run('INSERT INTO chat_members (chatId, userId, role) VALUES (?, ?, ?)', [chatId, req.user.id, 'owner']);
      
      // Добавляем участников
      userIds.forEach(userId => {
        db.run('INSERT INTO chat_members (chatId, userId, role) VALUES (?, ?, ?)', [chatId, userId, 'member']);
      });
      
      res.json({ success: true, chatId });
    }
  );
});

// Загрузка файлов
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({ url: fileUrl });
});

// Отправка жалобы
app.post('/api/report', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  
  const { reportedUserId, chatId, reason } = req.body;
  
  // Сохраняем в БД
  db.run(
    'INSERT INTO reports (reporterId, reportedUserId, chatId, reason) VALUES (?, ?, ?, ?)',
    [req.user.id, reportedUserId, chatId, reason]
  );
  
  // Отправляем на почту
  const mailOptions = {
    from: process.env.ADMIN_EMAIL,
    to: process.env.ADMIN_EMAIL,
    subject: '🚨 Новая жалоба в СПЕКТР',
    html: `
      <h2>Новая жалоба</h2>
      <p><strong>От:</strong> ${req.user.displayName} (${req.user.emails[0].value})</p>
      <p><strong>На пользователя:</strong> ${reportedUserId}</p>
      <p><strong>Чат:</strong> ${chatId}</p>
      <p><strong>Причина:</strong> ${reason}</p>
      <p><strong>Время:</strong> ${new Date().toLocaleString()}</p>
    `
  };
  
  try {
    await mailTransporter.sendMail(mailOptions);
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка отправки почты:', error);
    res.status(500).json({ error: 'Failed to send report' });
  }
});

// ===================== WEBSOCKET =====================
io.on('connection', (socket) => {
  console.log('Новое подключение:', socket.id);
  
  socket.on('join_chat', (chatId) => {
    socket.join('chat_' + chatId);
  });
  
  socket.on('send_message', async (data) => {
    const { chatId, type, content, fileUrl } = data;
    const userId = socket.request.session.passport?.user?.id;
    
    if (!userId) return;
    
    // Сохраняем в БД
    db.run(
      'INSERT INTO messages (chatId, userId, type, content, fileUrl) VALUES (?, ?, ?, ?, ?)',
      [chatId, userId, type, content, fileUrl],
      function() {
        const message = {
          id: this.lastID,
          chatId,
          userId,
          type,
          content,
          fileUrl,
          timestamp: new Date().toISOString(),
          user: socket.request.session.passport?.user
        };
        
        // Отправляем всем в чате
        io.to('chat_' + chatId).emit('new_message', message);
      }
    );
  });
  
  socket.on('typing', (data) => {
    socket.to('chat_' + data.chatId).emit('user_typing', {
      userId: socket.request.session.passport?.user?.id,
      name: socket.request.session.passport?.user?.displayName
    });
  });
});

// ===================== ЗАПУСК СЕРВЕРА =====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌈 СПЕКТР Социальная Сеть запущена!`);
  console.log(`👉 ${process.env.DOMAIN || `http://localhost:${PORT}`}`);
  
  // Создаём папку для загрузок
  if (!fs.existsSync('public/uploads')) {
    fs.mkdirSync('public/uploads', { recursive: true });
  }
});
