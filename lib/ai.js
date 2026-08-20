const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');

const MODEL_NAME = 'gemini-2.5-flash';

// Structured output: Gemini is constrained to this shape, which retires the
// ```json fence-stripping regex the old free-text path needed.
const TENDER_ARRAY_SCHEMA = {
  type: SchemaType.ARRAY,
  items: {
    type: SchemaType.OBJECT,
    properties: {
      title: { type: SchemaType.STRING },
      tender_number: { type: SchemaType.STRING },
      deadline_date: { type: SchemaType.STRING }
    },
    required: ['title', 'tender_number', 'deadline_date']
  }
};

// 1 attempt + 2 retries. Concurrent runs put up to CONCURRENCY calls in flight,
// which is where 429s start appearing; sequential runs almost never saw them.
const RETRY = { attempts: 3, baseMs: 1000 };

const TRANSIENT_MESSAGE = /\b(429|503)\b|rate.?limit|too many requests|overloaded|unavailable|timed? ?out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i;

// Worth retrying: rate limits, overloaded/unavailable models, network faults.
// NOT worth retrying: a bad API key, a permission error, an unparseable
// response — those fail identically every time and would just burn the budget.
function isTransient(err) {
  if (!err) return false;
  const status = err.status || err.statusCode;
  if (status === 429 || status === 503) return true;
  return TRANSIENT_MESSAGE.test(String(err.message || ''));
}

// Full jitter: a uniform point in [0, baseMs * 2^attempt). Concurrent workers
// that hit the same 429 must not retry in lockstep and re-collide.
function backoffMs(attempt, baseMs = RETRY.baseMs, rand = Math.random) {
  return Math.floor(rand() * baseMs * Math.pow(2, attempt));
}

const realSleep = (ms) => new Promise(r => setTimeout(r, ms));

function buildPrompt(rawText, excerpt) {
  const excerptNote = excerpt
    ? `\n    NOTE: The text below contains only EXCERPTS from the webpage, separated by "---" lines. It is NOT the full page. Extract every tender visible in these excerpts.\n`
    : "";
  return `
    You are an expert data extraction tool. Analyze the following raw webpage text from a municipality website.
    ${excerptNote}
    Extract all ACTIVE/OPEN tenders. For each tender, accurately extract:
    1. title: The full descriptive title of the tender in Hebrew. Clean any weird trailing chars.
    2. tender_number: The formal tender identifier/number. STRICLY STANDARDIZE the format to "NUMBER/YEAR" (e.g., if you see "47.26" or "47/26", format it strictly as "47/2026"). If no number exists, write "אין".
    3. deadline_date: The absolute final submission date formatted strictly as DD/MM/YYYY. If no year is provided, assume 2026. If no date is found, write "אין".

    Return ONLY a valid JSON array of objects. Do not wrap it in markdown code blocks. No explanations.
    Example format: [{"title": "שם מכרז נקי", "tender_number": "47/2026", "deadline_date": "15/08/2026"}]

    Text:
    ${rawText}
  `;
}

// The ONLY impure lib module: it talks to Gemini. Returns tenders:null on any
// failure — after bounded retry — so the caller leaves the cache untouched and
// retries next run. null and [] are NOT interchangeable: [] means "healthy
// page, zero open tenders" and legitimately updates the cache.
//
// `client`, `sleep`, `attempts` and `rand` are test seams: injecting a fake
// client is what keeps the retry tests offline and zero-token.
async function extractTenders(rawText, {
  excerpt = false,
  client = null,
  sleep = realSleep,
  attempts = RETRY.attempts,
  rand = Math.random
} = {}) {
  const genAI = client || new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const max = Math.max(1, attempts);
  let lastErr = null;
  let used = 0;

  for (let attempt = 0; attempt < max; attempt++) {
    used++;
    try {
      console.log(`🤖 Attempting extraction with model: ${MODEL_NAME}...`);
      const model = genAI.getGenerativeModel({
        model: MODEL_NAME,
        generationConfig: {
          temperature: 0.0,
          responseMimeType: 'application/json',
          responseSchema: TENDER_ARRAY_SCHEMA
        }
      });
      const result = await model.generateContent(buildPrompt(rawText, excerpt));
      const u = result.response.usageMetadata;
      const usage = {
        inputTokens: (u && u.promptTokenCount) || 0,
        outputTokens: (u && u.candidatesTokenCount) || 0
      };
      if (u) {
        console.log(`💰 Tokens — input: ${u.promptTokenCount}, output: ${u.candidatesTokenCount}, total: ${u.totalTokenCount}`);
      }
      return { tenders: JSON.parse(result.response.text()), usage, attempts: attempt + 1, error: null };
    } catch (e) {
      lastErr = e;
      if (!isTransient(e) || attempt === max - 1) break;
      await sleep(backoffMs(attempt, RETRY.baseMs, rand));
    }
  }

  console.warn(`❌ Model ${MODEL_NAME} failed (${(lastErr && lastErr.message) || 'unknown error'}). Returning null so cache is NOT updated.`);
  return {
    tenders: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    attempts: used,
    error: (lastErr && lastErr.message) || 'unknown error'
  };
}

module.exports = { extractTenders, buildPrompt, isTransient, backoffMs, RETRY, MODEL_NAME, TENDER_ARRAY_SCHEMA };
