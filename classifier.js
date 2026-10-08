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
  quiz: [
    'quiz', 'exam', 'test', 'midterm', 'mid-term', 'final exam',
    'viva', 'mcq', 'multiple choice', 'class test', 'assessment',
    'evaluation', 'online test',
  ],
  assignment: [
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

  return {
    important,
    reason: matchedKeywords.length
      ? `matched: ${matchedKeywords.join(', ')}`
      : 'no strong signals',
    dueDateText: extractDueDateText(haystack),
    category: categorize(haystack),
  };
}

module.exports = { classifyEmail, extractDueDateText, categorize };
