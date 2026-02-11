const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { initDB, getDB } = require('./database');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// ========== НАСТРОЙКИ ==========
const GOOGLE_CLIENT_ID = 'ТВОЙ_CLIENT_ID';
const GOOGLE_CLIENT_SECRET = 'ТВОЙ_CLIENT_SECRET';
const ADMIN_EMAIL = 'твоя_почта@gmail.com'; // Куда приходят жалобы
const EMAIL_PASSWORD = 'пароль_приложения'; // Пароль приложения Gmail

// Инициализация БД
initDB();

// Настройка загрузки файлов
const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Настройка почты
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: ADMIN_EMAIL,
    pass: EMAIL_PASSWORD
  }
});

// Сессии
app.use(session({
  secret: 'spectr-mega-secret-' + Date.now(),
  resave: false,
  saveUninitialized: true
}));

app.use(passport.initialize());
app.use(passport.session());

// Google OAuth
passport.use(new GoogleStrategy({
    clientID: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    callbackURL: 'https://sanyastail.onrender.com/auth/google/callback'
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      const db = getDB();
      
      // Проверяем есть ли пользователь
      let user = await db.get('SELECT * FROM users WHERE google_id = ?', profile.id);
      
      if (!user) {
        // Создаём нового
        await db.run(
          'INSERT INTO users (id, google_id, email, name, avatar) VALUES (?, ?, ?, ?, ?)',
          Date.now().toString(),
          profile.id,
          profile.emails[0].value,
          profile.displayName,
          profile.photos[0].value
        );
        
        user = await db.get('SELECT * FROM users WHERE google_id = ?', profile.id);
      }
      
      return done(null, user);
    } catch (error) {
      return done(error);
    }
  }
));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const db = getDB();
    const user = await db.get('SELECT * FROM users WHERE id = ?', id);
    done(null, user);
  } catch (error) {
    done(error);
  }
});

// Статические файлы
app.use('/uploads', express.static('uploads'));
app.use(express.static('public'));

// ========== API РОУТЫ ==========

// Главная страница
app.get('/', (req, res) => {
  if (req.isAuthenticated()) {
    res.sendFile(__dirname + '/public/app.html');
  } else {
    res.sendFile(__dirname + '/public/login.html');
  }
});

// Google аутентификация
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, res) => res.redirect('/')
);

app.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// API: Получить контакты
app.get('/api/contacts', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Не авторизован' });
  
  try {
    const db = getDB();
    const contacts = await db.all(`
      SELECT u.*, c.status 
      FROM contacts c
      JOIN users u ON u.id = c.contact_id
      WHERE c.user_id = ? AND c.status = 'accepted'
    `, req.user.id);
    
    res.json(contacts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Добавить контакт
app.post('/api/contacts/add', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Не авторизован' });
  
  try {
    const db = getDB();
    const { email } = req.body;
    
    // Находим пользователя по email
    const contact = await db.get('SELECT * FROM users WHERE email = ?', email);
    if (!contact) return res.status(404).json({ error: 'Пользователь не найден' });
    
    // Проверяем нет ли уже контакта
    const existing = await db.get(
      'SELECT * FROM contacts WHERE user_id = ? AND contact_id = ?',
      req.user.id, contact.id
    );
    
    if (!existing) {
      await db.run(
        'INSERT INTO contacts (user_id, contact_id, status) VALUES (?, ?, ?)',
        req.user.id, contact.id, 'pending'
      );
      
      // Уведомление в реальном времени
      io.to(contact.id).emit('contact_request', {
        from: req.user,
        to: contact
      });
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Создать чат
app.post('/api/chats/create', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Не авторизован' });
  
  try {
    const db = getDB();
    const { name, type, members } = req.body;
    
    // Создаём чат
    const result = await db.run(
      'INSERT INTO chats (name, type, created_by) VALUES (?, ?, ?)',
      name, type || 'group', req.user.id
    );
    
    const chatId = result.lastID;
    
    // Добавляем создателя как админа
    await db.run(
      'INSERT INTO chat_members (chat_id, user_id, role) VALUES (?, ?, ?)',
      chatId, req.user.id, 'admin'
    );
    
    // Добавляем участников
    for (const memberId of members) {
      await db.run(
        'INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)',
        chatId, memberId
      );
      
      // Уведомляем участников
      io.to(memberId).emit('chat_invite', {
        chatId,
        name,
        inviter: req.user
      });
    }
    
    res.json({ success: true, chatId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Отправить жалобу
app.post('/api/report', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Не авторизован' });
  
  try {
    const db = getDB();
    const { targetId, reason } = req.body;
    
    // Сохраняем в БД
    await db.run(
      'INSERT INTO reports (reporter_id, target_id, reason) VALUES (?, ?, ?)',
      req.user.id, targetId, reason
    );
    
    // Отправляем email администратору
    const targetUser = await db.get('SELECT * FROM users WHERE id = ?', targetId);
    
    await transporter.sendMail({
      from: ADMIN_EMAIL,
      to: ADMIN_EMAIL,
      subject: '🚨 ЖАЛОБА в SPECTR',
      html: `
        <h1>Новая жалоба</h1>
        <p><strong>От:</strong> ${req.user.name} (${req.user.email})</p>
        <p><strong>На:</strong> ${targetUser.name} (${targetUser.email})</p>
        <p><strong>Причина:</strong> ${reason}</p>
        <p><strong>Дата:</strong> ${new Date().toLocaleString()}</p>
      `
    });
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Загрузить файл
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Не авторизован' });
  
  res.json({
    success: true,
    url: `/uploads/${req.file.filename}`,
    type: req.file.mimetype.split('/')[0] // image/video
  });
});

// ========== WEBSOCKET ==========

io.on('connection', (socket) => {
  console.log('Новое подключение:', socket.id);
  
  // Привязываем socket к пользователю
  socket.on('identify', (userId) => {
    socket.join(userId);
    socket.userId = userId;
    
    // Уведомляем о онлайн статусе
    socket.broadcast.emit('user_online', userId);
  });
  
  // Отправка сообщения
  socket.on('send_message', async (data) => {
    try {
      const db = getDB();
      
      // Сохраняем в БД
      const result = await db.run(
        'INSERT INTO messages (chat_id, user_id, content, type, file_url) VALUES (?, ?, ?, ?, ?)',
        data.chatId, data.userId, data.content, data.type, data.fileUrl
      );
      
      const messageId = result.lastID;
      
      // Получаем полное сообщение
      const message = await db.get(`
        SELECT m.*, u.name, u.avatar 
        FROM messages m
        JOIN users u ON u.id = m.user_id
        WHERE m.id = ?
      `, messageId);
      
      // Получаем участников чата
      const members = await db.all(
        'SELECT user_id FROM chat_members WHERE chat_id = ?',
        data.chatId
      );
      
      // Отправляем всем участникам
      members.forEach(member => {
        io.to(member.user_id).emit('new_message', message);
      });
      
    } catch (error) {
      console.error('Ошибка отправки сообщения:', error);
    }
  });
  
  socket.on('disconnect', () => {
    if (socket.userId) {
      // Уведомляем о оффлайн статусе
      socket.broadcast.emit('user_offline', socket.userId);
    }
  });
});

// Создаём папку для загрузок
if (!fs.existsSync('./uploads')) {
  fs.mkdirSync('./uploads');
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 SPECTR SOCIAL запущен на порту ${PORT}`);
});
