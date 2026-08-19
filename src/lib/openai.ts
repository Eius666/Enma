// Client-side AI service layer.
// All actual OpenAI calls run server-side via /api/ai/* routes (API key is server-only).
// This module handles pre-flight checks (rate limit + AI usage limit) and caching.

import { checkAiLimit } from './aiLimits';
import { checkRateLimit, markRateLimitUsed } from './rateLimit';
import type { PlanType } from '../subscription';
import type { AiRequestType } from './aiLimits';

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
// Pre-flight guard — shared by all functions
// ─────────────────────────────────────────────────────────────────────────────

async function preflight(
  userId: string,
  plan: PlanType,
  type: AiRequestType,
  rateAction: 'ai_text' | 'ai_image' | 'ai_chat',
): Promise<void> {
  const [rateResult, limitResult] = await Promise.all([
    checkRateLimit(userId, rateAction),
    checkAiLimit(userId, plan, type),
  ]);

  if (!rateResult.allowed) {
    throw new AiLimitError('rate_limit', rateResult.retryAfterMs);
  }
  if (!limitResult.allowed) {
    const errorType = limitResult.limit === 0 ? 'plan_restricted' : 'monthly_limit';
    throw new AiLimitError(errorType, undefined, limitResult.used, limitResult.limit);
  }
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
// Sends transaction data to /api/ai/analyze.
// Result is cached 24 h per (userId, month).
// ─────────────────────────────────────────────────────────────────────────────

export interface ExpenseAnalysis {
  summary: string;
  insights: string[];
  topCategory: string;
  savingSuggestion: string;
}

export async function analyzeExpenses(
  transactions: unknown[],
  userId: string,
  plan: PlanType,
): Promise<ExpenseAnalysis> {
  const month    = new Date().toISOString().slice(0, 7);
  const cacheKey = `enma.ai.analysis.${userId}.${month}`;

  const cached = cacheGet<ExpenseAnalysis>(cacheKey);
  if (cached) return cached;

  await preflight(userId, plan, 'text', 'ai_text');

  const res = await fetch('/api/ai/analyze', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ userId, transactions, month }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? 'Analysis failed');
  }

  const result = (await res.json()) as ExpenseAnalysis;
  cacheSet(cacheKey, result);

  await markRateLimitUsed(userId, 'ai_text').catch(() => {});
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// generateImage
// DALL-E 3, 512×512. Premium only.
// ─────────────────────────────────────────────────────────────────────────────

export interface GeneratedImage {
  url: string;
  revisedPrompt?: string;
}

export async function generateImage(
  prompt: string,
  userId: string,
  plan: PlanType,
): Promise<GeneratedImage> {
  await preflight(userId, plan, 'image', 'ai_image');

  const res = await fetch('/api/ai/image', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ userId, prompt }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? 'Image generation failed');
  }

  const result = (await res.json()) as GeneratedImage;
  await markRateLimitUsed(userId, 'ai_image').catch(() => {});
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// generateReportPDF
// AI-generated summary + PDF. Premium only.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReportPDF {
  pdfUrl: string;
  summary: string;
}

export async function generateReportPDF(
  data: unknown,
  userId: string,
  plan: PlanType,
): Promise<ReportPDF> {
  await preflight(userId, plan, 'pdf', 'ai_text');

  const res = await fetch('/api/ai/report', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ userId, data }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? 'Report generation failed');
  }

  const result = (await res.json()) as ReportPDF;
  await markRateLimitUsed(userId, 'ai_text').catch(() => {});
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// chatAssistant
// AI chat with conversation context. Premium only.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatResponse {
  message: string;
  tokensUsed?: number;
}

export async function chatAssistant(
  message: string,
  history: ChatMessage[],
  userId: string,
  plan: PlanType,
): Promise<ChatResponse> {
  await preflight(userId, plan, 'text', 'ai_chat');

  const res = await fetch('/api/ai/chat', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ userId, message, history }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? 'Chat failed');
  }

  const result = (await res.json()) as ChatResponse;
  await markRateLimitUsed(userId, 'ai_chat').catch(() => {});
  return result;
}
