import OpenAI from 'openai';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_DEFAULT_MODEL = 'openai/gpt-4o-mini';

/**
 * @returns {{ client: OpenAI, model: string }}
 */
function createOpenRouterClient() {
  const openrouterKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!openrouterKey) {
    throw new Error(
      'OPENROUTER_API_KEY is not set (add it to your environment, e.g. .env)',
    );
  }
  const model =
    process.env.OPENROUTER_MODEL?.trim() || OPENROUTER_DEFAULT_MODEL;
  const client = new OpenAI({
    baseURL: OPENROUTER_BASE_URL,
    apiKey: openrouterKey,
    defaultHeaders: {
      'HTTP-Referer':
        process.env.OPENROUTER_HTTP_REFERER?.trim() || 'http://localhost',
      'X-Title':
        process.env.OPENROUTER_APP_TITLE?.trim() ||
        'customer-support-classifier',
    },
  });
  return { client, model };
}

/**
 * @param {OpenAI} client
 * @param {string} model
 * @param {string} message
 */
async function classifyWithOpenAIChat(client, model, message) {
  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: buildClassifierPrompt(message),
      },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Empty response from the chat API');
  }

  const { category, priority } = parseClassifierJson(content);
  return { message, category, priority };
}

function buildClassifierPrompt(message) {
  return `You are a strict support ticket classifier.

Your task:
Classify the given message into exactly ONE category and ONE priority based on the definitions below.

Categories (pick one label exactly as written):
- Billing — issues related to payments, charges, refunds, subscriptions
- Technical Issue — crashes, bugs, errors, app not working
- Account — login, profile, email, account access or security
- General Inquiry — general questions, information requests, non-issues

Priority (pick one):
- High — blocking issues, urgent problems, user cannot proceed
- Medium — partial issues, unclear problems, or lack of urgency
- Low — informational queries, general questions

Rules:
- Always choose exactly ONE category and ONE priority
- If the message is vague or unclear, default to:
  category: Account (if account-related) or General Inquiry
  priority: Medium
- If multiple issues are mentioned, prioritize the most critical one
- Do NOT invent new labels
- Be consistent and deterministic

Return ONLY valid JSON.
Do NOT include any explanation, markdown, or extra text.
Use EXACTLY this format and no additional keys:
{
  "category": "",
  "priority": ""
}

Message: ${JSON.stringify(message)}`;
}

/**
 * Extract and parse JSON from model output; handles markdown fences and extra text.
 * @param {string} text
 * @returns {{ category: string, priority: string }}
 */
function parseClassifierJson(text) {
  const trimmed = text.trim();
  let candidate = trimmed;

  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/im);
  if (fenceMatch) {
    candidate = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed.category === 'string' && typeof parsed.priority === 'string') {
      return { category: parsed.category, priority: parsed.priority };
    }
  } catch {
    // try fallback below
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      const parsed = JSON.parse(objectMatch[0]);
      if (parsed && typeof parsed.category === 'string' && typeof parsed.priority === 'string') {
        return { category: parsed.category, priority: parsed.priority };
      }
    } catch {
      // fall through
    }
  }

  throw new Error('Could not parse classifier JSON from model response');
}

/** Runs `fn` once; on failure waits 1s and runs `fn` one more time, then propagates errors. */
async function withApiRetry(fn) {
  try {
    return await fn();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return await fn();
  }
}

/**
 * @param {string} message
 * @returns {Promise<{ message: string, category: string, priority: string }>}
 */
export async function classifyMessage(message) {
  if (typeof message !== 'string' || message.trim() === '') {
    throw new TypeError('classifyMessage expects a non-empty string');
  }

  try {
    return await withApiRetry(async () => {
      const { client, model } = createOpenRouterClient();
      return await classifyWithOpenAIChat(client, model, message);
    });
  } catch (err) {
    if (err instanceof TypeError) {
      throw err;
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Classification failed: ${detail}`);
  }
}
