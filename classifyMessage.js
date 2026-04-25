import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';

const GEMINI_DEFAULT_MODEL = 'gemini-2.0-flash';
const OPENAI_MODEL = 'gpt-4o-mini';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_DEFAULT_MODEL = 'openai/gpt-4o-mini';

function getGeminiApiKey() {
  return (
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    ''
  );
}

/**
 * Which backend to use. Explicit LLM_PROVIDER wins; otherwise OpenRouter is
 * preferred when its key exists (avoids hitting Gemini quota when both keys are in .env).
 * @returns {'openrouter' | 'gemini' | 'openai'}
 */
function resolveProvider() {
  const raw = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (raw === 'openrouter' || raw === 'router') {
    if (!process.env.OPENROUTER_API_KEY?.trim()) {
      throw new Error(
        'LLM_PROVIDER=openrouter but OPENROUTER_API_KEY is missing',
      );
    }
    return 'openrouter';
  }
  if (raw === 'gemini' || raw === 'google') {
    if (!getGeminiApiKey()) {
      throw new Error(
        'LLM_PROVIDER=gemini but GEMINI_API_KEY (or GOOGLE_API_KEY) is missing',
      );
    }
    return 'gemini';
  }
  if (raw === 'openai') {
    if (!process.env.OPENAI_API_KEY?.trim()) {
      throw new Error('LLM_PROVIDER=openai but OPENAI_API_KEY is missing');
    }
    return 'openai';
  }

  if (process.env.OPENROUTER_API_KEY?.trim()) {
    return 'openrouter';
  }
  if (getGeminiApiKey()) {
    return 'gemini';
  }
  if (process.env.OPENAI_API_KEY?.trim()) {
    return 'openai';
  }

  throw new Error(
    'Missing API key: set OPENROUTER_API_KEY, GEMINI_API_KEY (or GOOGLE_API_KEY), or OPENAI_API_KEY in your environment (e.g. .env). Optional: LLM_PROVIDER=openrouter|gemini|openai',
  );
}

/**
 * @returns {{ client: OpenAI, model: string }}
 */
function createOpenRouterClient() {
  const openrouterKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!openrouterKey) {
    throw new Error('OPENROUTER_API_KEY is not set');
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
 * OpenAI API or compatible URL (e.g. OpenRouter via OPENAI_BASE_URL).
 * @returns {{ client: OpenAI, model: string }}
 */
function createOpenAIKeyClient() {
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  if (!openaiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }
  const customBaseUrl = process.env.OPENAI_BASE_URL?.trim();
  const useOpenRouter =
    customBaseUrl?.includes('openrouter.ai') ?? false;
  const model = useOpenRouter
    ? process.env.OPENROUTER_MODEL?.trim() || OPENROUTER_DEFAULT_MODEL
    : OPENAI_MODEL;
  const client = new OpenAI({
    apiKey: openaiKey,
    ...(customBaseUrl ? { baseURL: customBaseUrl } : {}),
    ...(useOpenRouter
      ? {
          defaultHeaders: {
            'HTTP-Referer':
              process.env.OPENROUTER_HTTP_REFERER?.trim() ||
              'http://localhost',
            'X-Title':
              process.env.OPENROUTER_APP_TITLE?.trim() ||
              'customer-support-classifier',
          },
        }
      : {}),
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

/**
 * Google AI Studio / Gemini API (API key from https://aistudio.google.com/apikey).
 * @param {string} message
 * @param {string} apiKey
 */
async function classifyWithGemini(message, apiKey) {
  const modelId =
    process.env.GEMINI_MODEL?.trim() || GEMINI_DEFAULT_MODEL;
  const genAI = new GoogleGenerativeAI(apiKey);
  const geminiModel = genAI.getGenerativeModel({
    model: modelId,
    generationConfig: {
      temperature: 0,
    },
  });

  const prompt = buildClassifierPrompt(message);
  const result = await geminiModel.generateContent(prompt);
  const content = result.response.text();
  if (!content) {
    throw new Error('Empty response from Gemini');
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

  let provider;
  try {
    provider = resolveProvider();
  } catch (err) {
    if (err instanceof TypeError) {
      throw err;
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Classification failed: ${detail}`);
  }

  try {
    return await withApiRetry(async () => {
      if (provider === 'gemini') {
        return await classifyWithGemini(message, getGeminiApiKey());
      }
      if (provider === 'openrouter') {
        const { client, model } = createOpenRouterClient();
        return await classifyWithOpenAIChat(client, model, message);
      }
      const { client, model } = createOpenAIKeyClient();
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
