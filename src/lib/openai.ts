// Client-side AI service layer.
// All actual OpenAI calls run server-side via /api/ai/* routes (API key is server-only).
// Limit checks and rate limiting are enforced server-side; this module only handles
// fetch, response parsing, and error conversion.

import type { PlanType } from '../subscription';

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export class AiLimitError extends Error {
  constructor(
    public readonly type: 'rate_limit' | 'monthly_limit' | 'plan_restricted',
    public readonly retryAfterMs?: number,
    public readonly used?: number,
    public readonly limit?: number,
  ) {
    super(type);
    this.name = 'AiLimitError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Base fetch — converts 429 body into AiLimitError
// ─────────────────────────────────────────────────────────────────────────────

async function aiPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(path, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  if (res.status === 429) {
    const err = await res.json().catch(() => ({})) as {
      code?: string;
      retryAfterMs?: number;
      used?: number;
      limit?: number;
    };
    const code = (err.code ?? 'monthly_limit') as AiLimitError['type'];
    throw new AiLimitError(code, err.retryAfterMs, err.used, err.limit);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `AI request failed (${res.status})`);
  }

  return res.json() as Promise<T>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache helpers (localStorage, 24 h TTL)
// ─────────────────────────────────────────────────────────────────────────────

const TTL_MS = 24 * 60 * 60 * 1000;

function cacheGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { value, cachedAt } = JSON.parse(raw) as { value: T; cachedAt: number };
    if (Date.now() - cachedAt > TTL_MS) return null;
    return value;
  } catch {
    return null;
  }
}

function cacheSet<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify({ value, cachedAt: Date.now() }));
  } catch { /* storage full — ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// analyzeExpenses
// ─────────────────────────────────────────────────────────────────────────────

export interface ExpenseAnalysis {
  summary: string;
  insights: string[];
  topCategory: string;
  savingSuggestion: string;
  remaining?: number;
}

export async function analyzeExpenses(
  transactions: unknown[],
  userId: string,
  _plan: PlanType,
): Promise<ExpenseAnalysis> {
  const month    = new Date().toISOString().slice(0, 7);
  const cacheKey = `enma.ai.analysis.${userId}.${month}`;

  const cached = cacheGet<ExpenseAnalysis>(cacheKey);
  if (cached) return cached;

  const result = await aiPost<ExpenseAnalysis>('/api/ai/analyze', { userId, transactions, month });
  cacheSet(cacheKey, result);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// generateImage
// ─────────────────────────────────────────────────────────────────────────────

export interface GeneratedImage {
  url: string;
  revisedPrompt?: string;
  remaining?: number;
}

export async function generateImage(
  prompt: string,
  userId: string,
  _plan: PlanType,
): Promise<GeneratedImage> {
  return aiPost<GeneratedImage>('/api/ai/image', { userId, prompt });
}

// ─────────────────────────────────────────────────────────────────────────────
// generateReportPDF
// ─────────────────────────────────────────────────────────────────────────────

export interface ReportPDF {
  html: string;
  remaining?: number;
}

export async function generateReportPDF(
  data: unknown,
  userId: string,
  _plan: PlanType,
): Promise<ReportPDF> {
  return aiPost<ReportPDF>('/api/ai/report', { userId, data });
}

// ─────────────────────────────────────────────────────────────────────────────
// chatAssistant
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatResponse {
  message: string;
  remaining?: number;
}

export async function chatAssistant(
  message: string,
  history: ChatMessage[],
  userId: string,
  _plan: PlanType,
): Promise<ChatResponse> {
  return aiPost<ChatResponse>('/api/ai/chat', { userId, message, history });
}

// ─────────────────────────────────────────────────────────────────────────────
// categorizeTransaction — suggests a preset category for a transaction
// Never throws: returns fallback on any error so the UI is never blocked.
// ─────────────────────────────────────────────────────────────────────────────

export interface CategoryResult {
  categoryId: string;
  confidence: number;
}

export async function categorizeTransaction(
  description: string,
  amount: number,
  userId: string,
): Promise<CategoryResult> {
  try {
    return await aiPost<CategoryResult>('/api/ai/categorize', { userId, description, amount });
  } catch {
    return { categoryId: 'p-other-e', confidence: 0.5 };
  }
}
