// server.js — main entry point

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');

const db = require('./db');
const { createOAuthClient, getAuthUrl, SCOPES } = require('./googleAuth');
const { startScheduler } = require('./scheduler');
const { runScanForUser } = require('./scanner');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 }, // 30 days
}));

// Keep-alive ping endpoint — an external cron service can hit this to
// prevent free-tier hosts (like Render) from putting the app to sleep.
app.get('/ping', (req, res) => res.send('pong'));

// --- Auth routes ------------------------------------------------------

app.get('/login', (req, res) => {
  res.redirect(getAuthUrl());
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing authorization code.');

  try {
    const oauth2Client = createOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    if (!tokens.refresh_token) {
      return res.status(400).send(
        'No refresh token received. This usually happens if you have logged in before. ' +
        'Go to https://myaccount.google.com/permissions, remove access for this app, then try logging in again.'
      );
    }

    // Get the user's email address
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();

    const userId = crypto.createHash('sha256').update(userInfo.email).digest('hex').slice(0, 16);

    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (existing) {
      db.prepare('UPDATE users SET refresh_token = ?, email = ? WHERE id = ?')
        .run(tokens.refresh_token, userInfo.email, userId);
    } else {
      const ntfyTopic = `college-tracker-${crypto.randomBytes(6).toString('hex')}`;
      db.prepare('INSERT INTO users (id, email, refresh_token, ntfy_topic) VALUES (?, ?, ?, ?)')
        .run(userId, userInfo.email, tokens.refresh_token, ntfyTopic);
    }

    req.session.userId = userId;
    res.redirect('/dashboard');
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send('Login failed: ' + err.message);
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// --- Middleware ---------------------------------------------------------

function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

// --- Pages ---------------------------------------------------------------

app.get('/', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.render('home');
});

// The four dashboard sections, in the order they should appear on screen.
const CATEGORY_SECTIONS = [
  { key: 'assignments', label: 'Assignments' },
  { key: 'notes', label: 'Notes' },
  { key: 'quizzes', label: 'Quizzes' },
  { key: 'miscellaneous', label: 'Other Notifications' },
];

app.get('/dashboard', requireLogin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);

  // Sorting / filtering options come from the query string, e.g.
  //   /dashboard?sort=subject&faculty=Dr.%20Rao
  const sort = ['due', 'subject', 'faculty'].includes(req.query.sort) ? req.query.sort : 'due';
  const subjectFilter = (req.query.subject || '').trim();
  const facultyFilter = (req.query.faculty || '').trim();

  const allTasks = db.prepare(`
    SELECT * FROM tasks WHERE user_id = ? AND completed = 0
    ORDER BY
      CASE WHEN due_date IS NULL THEN 1 ELSE 0 END,
      due_date ASC,
      created_at DESC
  `).all(user.id);

  // Dropdown options come from ALL pending tasks (not the filtered set),
  // so you can always switch to a different subject/faculty.
  const uniq = key => [...new Set(allTasks.map(t => t[key]).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  const subjects = uniq('subject');
  const faculties = uniq('faculty');

  let tasks = allTasks.filter(t =>
    (!subjectFilter || t.subject === subjectFilter) &&
    (!facultyFilter || t.faculty === facultyFilter)
  );

  // Sort within each column. Array.sort is stable, so the due-date order
  // from SQL is kept inside each subject / faculty group.
  // Tasks with no subject/faculty go last.
  if (sort === 'subject' || sort === 'faculty') {
    tasks = tasks.slice().sort((a, b) => {
      const x = a[sort], y = b[sort];
      if (!x && !y) return 0;
      if (!x) return 1;
      if (!y) return -1;
      return x.localeCompare(y);
    });
  }

  // Group into sections. Anything with a missing/unrecognized category
  // (e.g. rows from before this feature existed) falls back to miscellaneous.
  const sections = CATEGORY_SECTIONS.map(section => ({
    ...section,
    tasks: tasks.filter(t => (t.category || 'miscellaneous') === section.key),
  }));

  res.render('dashboard', {
    user, tasks, sections,
    sort, subjectFilter, facultyFilter, subjects, faculties,
  });
});

// --- API routes (used by the dashboard's JS) ------------------------------

app.post('/api/scan-now', requireLogin, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  await runScanForUser(user);
  res.json({ ok: true });
});

app.post('/api/tasks/:id/complete', requireLogin, (req, res) => {
  db.prepare('UPDATE tasks SET completed = 1 WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.session.userId);
  res.json({ ok: true });
});

app.post('/api/settings/ntfy-topic', requireLogin, (req, res) => {
  const { topic } = req.body;
  if (!topic || !/^[a-zA-Z0-9_-]+$/.test(topic)) {
    return res.status(400).json({ ok: false, error: 'Invalid topic name.' });
  }
  db.prepare('UPDATE users SET ntfy_topic = ? WHERE id = ?').run(topic, req.session.userId);
  res.json({ ok: true });
});

// --- Boot -----------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`College Tracker running on http://localhost:${PORT}`);
  startScheduler();
});
