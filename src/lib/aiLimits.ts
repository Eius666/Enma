import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { AI_LIMITS } from '../subscription';
import type { PlanType } from '../subscription';
import type { AiUsage } from '../types';

export type AiRequestType = 'text' | 'image' | 'pdf';

const currentMonth = () => new Date().toISOString().slice(0, 7);

// ─────────────────────────────────────────────────────────────────────────────
// Read current AI usage for a user (client-side read, server writes via Admin SDK)
// ─────────────────────────────────────────────────────────────────────────────

export async function getAiUsage(userId: string, month?: string): Promise<AiUsage> {
  const m    = month ?? currentMonth();
  const snap = await getDoc(doc(db, 'aiUsage', userId));

  if (!snap.exists()) {
    return { userId, month: m, textRequests: 0, imageRequests: 0, pdfReports: 0 };
  }

  const d = snap.data();
  if (d.month !== m) {
    return { userId, month: m, textRequests: 0, imageRequests: 0, pdfReports: 0 };
  }

  return {
    userId,
    month: m,
    textRequests:  d.textRequests  ?? 0,
    imageRequests: d.imageRequests ?? 0,
    pdfReports:    d.pdfReports    ?? 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check if a user can make an AI request of the given type
// ─────────────────────────────────────────────────────────────────────────────

export async function checkAiLimit(
  userId: string,
  plan: PlanType,
  type: AiRequestType,
): Promise<{ allowed: boolean; used: number; limit: number }> {
  const limits = AI_LIMITS[plan];
  const limit  = type === 'text'  ? limits.textRequests
               : type === 'image' ? limits.imageRequests
               : limits.pdfReports;

  if (limit === 0) return { allowed: false, used: 0, limit: 0 };

  const usage = await getAiUsage(userId);
  const used  = type === 'text'  ? usage.textRequests
              : type === 'image' ? usage.imageRequests
              : usage.pdfReports;

  return { allowed: used < limit, used, limit };
}

// ─────────────────────────────────────────────────────────────────────────────
// incrementAiUsage / resetAiUsage
// NOTE: /aiUsage/{userId} is write-protected for clients (firestore.rules).
// These functions are provided for the server-side api/ routes that run via
// the Admin SDK, which bypasses Firestore Security Rules.
// Do NOT call these from client-side components.
// ─────────────────────────────────────────────────────────────────────────────

export function buildAiUsageIncrement(
  currentData: Partial<AiUsage> | undefined,
  type: AiRequestType,
  month: string,
): AiUsage {
  const sameMonth = currentData?.month === month;
  return {
    userId:        currentData?.userId ?? '',
    month,
    textRequests:  (sameMonth ? (currentData?.textRequests  ?? 0) : 0) + (type === 'text'  ? 1 : 0),
    imageRequests: (sameMonth ? (currentData?.imageRequests ?? 0) : 0) + (type === 'image' ? 1 : 0),
    pdfReports:    (sameMonth ? (currentData?.pdfReports    ?? 0) : 0) + (type === 'pdf'   ? 1 : 0),
  };
}
