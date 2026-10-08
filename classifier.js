// classifier.js — free, rule-based detection of "important college email"
// No AI API needed. Tuned for typical college/classroom emails.

// Words that strongly suggest an actionable academic task
const TASK_KEYWORDS = [
  'assignment', 'homework', 'submit', 'submission', 'due', 'deadline',
  'exam', 'quiz', 'test', 'midterm', 'final exam', 'project', 'report',
  'presentation', 'viva', 'lab', 'syllabus', 'reschedul', 'postpon',
  'extended', 'extension', 'grade', 'grades', 'result', 'attendance',
  'registration', 'register', 'fee payment', 'last date', 'circular',
  'notice', 'reminder', 'classroom', 'google form', 'upload your',
  'class test', 'internal assessment', 'evaluation'
];

// Words that suggest promotional/irrelevant mail — used to suppress false positives
const NOISE_KEYWORDS = [
  'unsubscribe', 'newsletter', 'sale', 'discount', 'webinar invite',
  'no-reply@linkedin', 'promotion', 'congratulations you', 'win a prize'
];

// Keyword groups used to sort an item into one of the four dashboard sections.
// Checked in this order — first match wins — because a title like
// "Quiz 2 submission" should land under Quizzes, not Assignments.
const CATEGORY_KEYWORDS = {
  quizzes: [
    'quiz', 'exam', 'test', 'midterm', 'mid-term', 'final exam',
    'viva', 'mcq', 'multiple choice', 'class test', 'assessment',
    'evaluation', 'online test',
  ],
  assignments: [
    'assignment', 'homework', 'submit', 'submission', 'due', 'deadline',
    'project', 'report', 'presentation', 'lab', 'upload your',
    'internal assessment', 'coursework',
  ],
  notes: [
    'notes', 'material', 'materials', 'reading', 'resource', 'resources',
    'syllabus', 'slides', 'ppt', 'ebook', 'reference book', 'pdf',
    'chapter', 'handout', 'study material',
  ],
};

/**
 * Sort a piece of text (subject/title + body/description) into one of:
 * 'notes' | 'assignments' | 'quizzes' | 'miscellaneous'.
 * Falls back to 'miscellaneous' — the catch-all for circulars, results,
 * attendance, fee reminders, general notices, etc.
 */
function categorize(text) {
  const haystack = (text || '').toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(kw => haystack.includes(kw))) {
      return category;
    }
  }
  return 'miscellaneous';
}

// Common date phrases we try to pull out, e.g. "due on 5th July", "by 12/08", "before Monday"
const DATE_PATTERNS = [
  /\b(due|deadline|submit(?:ted)? by|before|by)\s*(on)?\s*[:\-]?\s*(\d{1,2}(?:st|nd|rd|th)?\s+\w+(?:\s+\d{2,4})?)/i,
  /\b(due|deadline|submit(?:ted)? by|before|by)\s*(on)?\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/i,
  /\b(\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s*\d{0,4})/i,
];

const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTH_INDEX = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

/**
 * Turn the loose date text found in an email ("5th July", "12/08/2026",
 * "3 oct 26") into an ISO date ("2026-07-05") so it can be placed on the
 * calendar. Numeric dates are read day-first (12/08 = 12 August).
 * When the year is missing we assume the current year, or next year if that
 * would put the date more than ~3 months in the past.
 * Returns null if the text can't be understood.
 */
function parseDueDate(text, now = new Date()) {
  if (!text) return null;
  const s = String(text).toLowerCase().trim();
  let day, month, year;

  let m = s.match(new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b\\.?,?\\s*(\\d{2,4})?`));
  if (m) {
    day = +m[1];
    month = MONTH_INDEX.indexOf(m[2].slice(0, 3)) + 1;
    year = m[3];
  } else {
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
    if (!m) return null;
    day = +m[1];
    month = +m[2];
    year = m[3];
  }

  if (year) {
    year = +year;
    if (year < 100) year += 2000;
  } else {
    year = now.getFullYear();
    const guess = new Date(Date.UTC(year, month - 1, day));
    if (guess < now.getTime() - 90 * 86400000) year += 1;
  }

  // Reject impossible dates like 31/02
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return dt.toISOString().slice(0, 10);
}

function extractDueDateText(text) {
  for (const pattern of DATE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      // Return the last captured group, which is usually the actual date chunk
      return match[match.length - 1].trim();
    }
  }
  return null;
}

/**
 * Decide if an email is "important" using keyword scoring.
 * @param {string} subject
 * @param {string} bodyText - plain text snippet/body of the email
 * @param {string} fromAddress
 * @param {string[]} trustedDomains - e.g. ['college.edu'] — emails from these score higher
 * @returns {{ important: boolean, reason: string, dueDateText: string|null }}
 */
function classifyEmail(subject, bodyText, fromAddress, trustedDomains = []) {
  const haystack = `${subject} ${bodyText}`.toLowerCase();

  // Hard noise filter first
  const isNoise = NOISE_KEYWORDS.some(k => haystack.includes(k));
  if (isNoise) {
    return { important: false, reason: 'matched noise keyword', dueDateText: null };
  }

  let score = 0;
  const matchedKeywords = [];

  for (const kw of TASK_KEYWORDS) {
    if (haystack.includes(kw)) {
      score += 1;
      matchedKeywords.push(kw);
    }
  }

  // Boost score heavily if the sender is from a trusted college domain
  const fromTrustedDomain = trustedDomains.some(domain =>
    fromAddress.toLowerCase().includes(domain.toLowerCase())
  );
  if (fromTrustedDomain) score += 2;

  const important = score >= 2; // tweakable threshold

  const dueDateText = extractDueDateText(haystack);

  return {
    important,
    reason: matchedKeywords.length
      ? `matched: ${matchedKeywords.join(', ')}`
      : 'no strong signals',
    dueDateText,
    dueDate: parseDueDate(dueDateText), // ISO date or null — used by the calendar
    category: categorize(haystack),
  };
}

module.exports = { classifyEmail, extractDueDateText, parseDueDate, categorize };
