const crypto = require('crypto');

const JUNK_WORDS = [
  "נגישות", "הצהרת נגישות", "מפת האתר", "כל הזכויות שמורות", "צור קשר",
  "פייסבוק", "טוויטר", "יוטיוב", "אינסטגרם", "דילוג לתוכן", "מוקדי שירות",
  "דלג לתוכן המרכזי", "שירות לאזרח", "מדיניות פרטיות", "תנאי שימוש",
  "sharepoint", "session", "token", "powered by", "webpack",
  "חדשות", "מבזק", "אירועים", "לוח אירועים"
];

const NOISE_WORDS = new Set([
  "יום", "ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת",
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
  "שעה", "שעות", "דקה", "דקות", "שניה", "שניות", "היום", "מחר", "אתמול",
  "תאריך", "עודכן", "אחרון", "פורסם", "צפיות", "קוראים", "תגובות",
  "עמוד", "דף", "מתוך", "הבא", "הקודם", "הבאים", "קודמים", "לפני", "הצג", "עוד"
]);

function superCleanText(text) {
  if (!text) return "";
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => {
      if (line.length === 0) return false;
      if (line.includes("{") || line.includes("}") || line.includes("]=") || line.includes("typeof") || line.includes("!important") || line.includes("-->")) return false;

      const englishAndSpecs = line.match(/[a-zA-Z0-9_\-\/]/g) || [];
      if (line.length > 40 && (englishAndSpecs.length / line.length) > 0.6) return false;

      if (line.length < 100) {
        return !JUNK_WORDS.some(word => line.toLowerCase().includes(word.toLowerCase()));
      }
      return true;
    })
    .join('\n')
    .replace(/[ \t]+/g, ' ');
}

// The per-line identity used for diffing. Digits are stripped so dynamic
// numbers (dates, view counters) don't create false diffs — same trade-off
// as the old whole-page hash.
function stableKey(line) {
  const cleanLine = line.replace(/\d+/g, '').replace(/[^\u0590-\u05FFa-zA-Z\s]/g, ' ').trim();
  const words = cleanLine.split(/\s+/).filter(w => w.length > 1 && !NOISE_WORDS.has(w));
  if (words.length < 4) return null;
  return words.join(' ');
}

function buildEntries(cleanedText) {
  return cleanedText.split('\n').map(line => ({ line, key: stableKey(line) }));
}

// Content hash per stable key: md5 of the digit-INCLUSIVE lines that map to
// that key, sorted so collision order does not matter. This is the signal that
// a number (e.g. a deadline) changed under an otherwise-identical line. Noise
// lines (key === null) are excluded — they are never diffed.
function buildKeyHashes(entries) {
  const linesByKey = new Map();
  for (const e of entries) {
    if (e.key === null) continue;
    if (!linesByKey.has(e.key)) linesByKey.set(e.key, []);
    linesByKey.get(e.key).push(e.line);
  }
  const out = {};
  for (const [key, lines] of linesByKey) {
    const joined = lines.slice().sort().join('\n');
    out[key] = crypto.createHash('md5').update(joined).digest('hex');
  }
  return out;
}

module.exports = { superCleanText, stableKey, buildEntries, buildKeyHashes };
