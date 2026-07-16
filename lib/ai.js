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
// failure so the caller leaves the cache untouched and retries next run.
async function extractTenders(rawText, { excerpt = false } = {}) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
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
    const usage = { inputTokens: (u && u.promptTokenCount) || 0, outputTokens: (u && u.candidatesTokenCount) || 0 };
    if (u) {
      console.log(`💰 Tokens — input: ${u.promptTokenCount}, output: ${u.candidatesTokenCount}, total: ${u.totalTokenCount}`);
    }
    return { tenders: JSON.parse(result.response.text()), usage };
  } catch (e) {
    console.warn(`❌ Model ${MODEL_NAME} failed (${e.message}). Returning null so cache is NOT updated.`);
    return { tenders: null, usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

module.exports = { extractTenders, buildPrompt, MODEL_NAME, TENDER_ARRAY_SCHEMA };
