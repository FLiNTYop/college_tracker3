// scanner.js — the core engine. Run on a schedule (see scheduler.js).
// 1. Pulls recent Gmail messages, classifies them, stores important ones as tasks.
// 2. Pulls Classroom coursework/announcements with due dates, stores as tasks.
// 3. For anything newly stored, sends a push notification.

const { google } = require('googleapis');
const db = require('./db');
const { classifyEmail, categorize } = require('./classifier');
const { getClientForUser } = require('./googleAuth');
// ntfy push notifications are disabled for now (notify.js is kept for later).
// const { sendPush } = require('./notify');

const TRUSTED_DOMAINS = (process.env.TRUSTED_EMAIL_DOMAINS || '')
  .split(',')
  .map(d => d.trim())
  .filter(Boolean);

// --- helpers -----------------------------------------------------------

function getHeader(headers, name) {
  const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function decodeBase64Url(data) {
  if (!data) return '';
  return Buffer.from(data, 'base64url').toString('utf-8');
}

function extractPlainText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }
  return '';
}

// Turn a raw From header ('Dr. Rao <rao@college.edu>') into a readable name.
function senderName(from) {
  const name = (from || '').replace(/<[^>]*>/g, '').replace(/["']/g, '').trim();
  return name || (from || '').trim() || null;
}

// Look up the teacher(s) of a Classroom course. Needs the rosters + profile
// scopes; if the user logged in before those were added, this quietly
// returns null and the card just shows no faculty until they log in again.
const facultyCache = new Map();
async function getFacultyName(classroom, course) {
  if (facultyCache.has(course.id)) return facultyCache.get(course.id);
  let faculty = null;
  try {
    const res = await classroom.courses.teachers.list({ courseId: course.id });
    const names = (res.data.teachers || [])
      .map(t => t.profile && t.profile.name && t.profile.name.fullName)
      .filter(Boolean);
    if (names.length) faculty = names.join(', ');
  } catch (e) {
    console.warn(`Could not fetch teachers for ${course.name}:`, e.message);
  }
  facultyCache.set(course.id, faculty);
  return faculty;
}

// Gmail has no "course" field, so try to match the email against the
// subjects we already know from Classroom (e.g. 'Data Structures').
function guessSubject(user, text) {
  const known = db.prepare(
    `SELECT DISTINCT subject FROM tasks WHERE user_id = ? AND source = 'classroom' AND subject IS NOT NULL AND subject != ''`
  ).all(user.id);
  const haystack = (text || '').toLowerCase();
  const hit = known.find(k => haystack.includes(k.subject.toLowerCase()));
  return hit ? hit.subject : null;
}

// Save the real "posted on" time for rows that were stored before the
// calendar feature existed (the scanner otherwise skips rows it already has).
function backfillPosted(taskId, timestamp) {
  if (!timestamp) return;
  db.prepare(
    `UPDATE tasks SET posted_date = ? WHERE id = ? AND (posted_date IS NULL OR posted_date = '')`
  ).run(timestamp, taskId);
}

// --- Gmail scanning ------------------------------------------------------

async function scanGmail(user) {
  const auth = getClientForUser(user.refresh_token);
  const gmail = google.gmail({ version: 'v1', auth });

  // Only look at mail from the last 2 days to keep this fast and cheap
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'newer_than:2d',
    maxResults: 30,
  });

  const messages = res.data.messages || [];
  const newTasks = [];

  for (const msgRef of messages) {
    const already = db.prepare(
      'SELECT 1 FROM processed_emails WHERE message_id = ? AND user_id = ?'
    ).get(msgRef.id, user.id);
    if (already) continue; // skip ones we've already checked before

    const full = await gmail.users.messages.get({
      userId: 'me',
      id: msgRef.id,
      format: 'full',
    });

    const headers = full.data.payload.headers || [];
    const subject = getHeader(headers, 'Subject');
    const from = getHeader(headers, 'From');
    const bodyText = extractPlainText(full.data.payload) || full.data.snippet || '';

    const result = classifyEmail(subject, bodyText, from, TRUSTED_DOMAINS);

    // Mark as processed regardless of outcome, so we never re-check it
    db.prepare(
      'INSERT OR IGNORE INTO processed_emails (message_id, user_id) VALUES (?, ?)'
    ).run(msgRef.id, user.id);

    if (result.important) {
      const taskId = `gmail_${msgRef.id}`;
      const existing = db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId);
      if (!existing) {
        db.prepare(`
          INSERT INTO tasks (id, user_id, source, title, detail, due_date, course_or_sender, link, notified, category, subject, faculty, posted_date)
          VALUES (?, ?, 'gmail', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
        `).run(
          taskId,
          user.id,
          subject || '(no subject)',
          bodyText.slice(0, 300),
          result.dueDate, // ISO date (or null) so the calendar can place it
          from,
          `https://mail.google.com/mail/u/0/#inbox/${msgRef.id}`,
          result.category,
          guessSubject(user, `${subject} ${bodyText}`),
          senderName(from),
          full.data.internalDate
            ? new Date(Number(full.data.internalDate)).toISOString()
            : new Date().toISOString()
        );
        newTasks.push(taskId);
      }
    }
  }

  return newTasks;
}

// --- Classroom scanning ---------------------------------------------------

async function scanClassroom(user) {
  const auth = getClientForUser(user.refresh_token);
  const classroom = google.classroom({ version: 'v1', auth });

  const newTasks = [];

  const coursesRes = await classroom.courses.list({ courseStates: ['ACTIVE'] });
  const courses = coursesRes.data.courses || [];

  for (const course of courses) {
    const faculty = await getFacultyName(classroom, course);

    // Fill in faculty for rows saved before this feature existed.
    if (faculty) {
      db.prepare(
        `UPDATE tasks SET faculty = ? WHERE user_id = ? AND source = 'classroom' AND subject = ? AND (faculty IS NULL OR faculty = '')`
      ).run(faculty, user.id, course.name);
    }

    // --- 1. Coursework: assignments, quizzes, tests ---
    // Previously this skipped anything without a due date. We now track
    // everything — a due date just becomes optional metadata rather than
    // a requirement to appear at all.
    let courseWork = [];
    try {
      const cwRes = await classroom.courses.courseWork.list({ courseId: course.id });
      courseWork = cwRes.data.courseWork || [];
    } catch (e) {
      console.warn(`Could not fetch coursework for ${course.name}:`, e.message);
    }

    for (const work of courseWork) {
      const taskId = `classroom_work_${work.id}`;
      const existing = db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId);
      if (existing) { backfillPosted(taskId, work.creationTime); continue; }

      let dueDate = null;
      if (work.dueDate) {
        const { year, month, day } = work.dueDate;
        dueDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }

      // Classroom's own workType is the strongest signal for quiz-style work
      // (Google Forms quizzes come through as short-answer/multiple-choice).
      // Otherwise fall back to keyword sniffing, and default to
      // 'assignments' rather than 'miscellaneous' since this came from the
      // Coursework API — it's graded work by definition.
      let category;
      if (work.workType === 'MULTIPLE_CHOICE_QUESTION' || work.workType === 'SHORT_ANSWER_QUESTION') {
        category = 'quizzes';
      } else {
        const guessed = categorize(`${work.title || ''} ${work.description || ''}`);
        category = guessed === 'miscellaneous' ? 'assignments' : guessed;
      }

      db.prepare(`
        INSERT INTO tasks (id, user_id, source, title, detail, due_date, course_or_sender, link, notified, category, subject, faculty, posted_date)
        VALUES (?, ?, 'classroom', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      `).run(
        taskId,
        user.id,
        work.title || '(untitled assignment)',
        work.description ? work.description.slice(0, 300) : '',
        dueDate,
        course.name,
        work.alternateLink || '',
        category,
        course.name,
        faculty,
        work.creationTime || null
      );
      newTasks.push(taskId);
    }

    // --- 2. Coursework materials: notes, reading material, resources ---
    // These never have due dates by nature, but you still want to know
    // when a teacher uploads something new.
    let materials = [];
    try {
      const matRes = await classroom.courses.courseWorkMaterials.list({ courseId: course.id });
      materials = matRes.data.courseWorkMaterial || [];
    } catch (e) {
      console.warn(`Could not fetch materials for ${course.name}:`, e.message);
    }

    for (const mat of materials) {
      const taskId = `classroom_material_${mat.id}`;
      const existing = db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId);
      if (existing) { backfillPosted(taskId, mat.creationTime); continue; }

      db.prepare(`
        INSERT INTO tasks (id, user_id, source, title, detail, due_date, course_or_sender, link, notified, category, subject, faculty, posted_date)
        VALUES (?, ?, 'classroom', ?, ?, NULL, ?, ?, 0, 'notes', ?, ?, ?)
      `).run(
        taskId,
        user.id,
        mat.title ? `New material: ${mat.title}` : 'New material posted',
        mat.description ? mat.description.slice(0, 300) : '',
        course.name,
        mat.alternateLink || '',
        course.name,
        faculty,
        mat.creationTime || null
      );
      newTasks.push(taskId);
    }

    // --- 3. Announcements: general posts, often used for notes/reminders ---
    let announcements = [];
    try {
      const annRes = await classroom.courses.announcements.list({ courseId: course.id });
      announcements = annRes.data.announcements || [];
    } catch (e) {
      console.warn(`Could not fetch announcements for ${course.name}:`, e.message);
    }

    for (const ann of announcements) {
      const taskId = `classroom_announcement_${ann.id}`;
      const existing = db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId);
      if (existing) { backfillPosted(taskId, ann.creationTime); continue; }

      const text = ann.text || '';
      // Skip announcements that are clearly trivial/empty to reduce noise
      if (!text.trim()) continue;

      // Announcements are usually general notices, but sometimes teachers
      // use them to post notes or remind about an assignment/quiz — so we
      // still sniff for keywords before falling back to miscellaneous.
      const category = categorize(text);

      db.prepare(`
        INSERT INTO tasks (id, user_id, source, title, detail, due_date, course_or_sender, link, notified, category, subject, faculty, posted_date)
        VALUES (?, ?, 'classroom', ?, ?, NULL, ?, ?, 0, ?, ?, ?, ?)
      `).run(
        taskId,
        user.id,
        'New announcement',
        text.slice(0, 300),
        course.name,
        ann.alternateLink || '',
        category,
        course.name,
        faculty,
        ann.creationTime || null
      );
      newTasks.push(taskId);
    }
  }

  return newTasks;
}

// --- Notification dispatch -------------------------------------------------

async function notifyNewTasks(user, taskIds) {
  // Push notifications are turned off for now. We only mark tasks as
  // notified so they are not picked up again if notifications come back.
  if (!taskIds.length) return;

  db.prepare(
    `UPDATE tasks SET notified = 1 WHERE id IN (${taskIds.map(() => '?').join(',')})`
  ).run(...taskIds);
}

// --- Entry point called by the scheduler -----------------------------------

async function runScanForUser(user) {
  console.log(`[scanner] Running scan for user ${user.email}`);
  try {
    const gmailTasks = await scanGmail(user);
    const classroomTasks = await scanClassroom(user);
    const allNew = [...gmailTasks, ...classroomTasks];
    await notifyNewTasks(user, allNew);
    console.log(`[scanner] Done. ${allNew.length} new task(s) found for ${user.email}`);
  } catch (err) {
    console.error(`[scanner] Error scanning for ${user.email}:`, err.message);
  }
}

async function runScanForAllUsers() {
  const users = db.prepare('SELECT * FROM users WHERE refresh_token IS NOT NULL').all();
  for (const user of users) {
    await runScanForUser(user);
  }
}

module.exports = { runScanForUser, runScanForAllUsers };
