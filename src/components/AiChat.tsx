import React, { useCallback, useEffect, useRef, useState } from 'react';
import { User } from 'firebase/auth';
import {
  collection,
  addDoc,
  query,
  orderBy,
  limit as firestoreLimit,
  onSnapshot,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import { FaArrowLeft, FaPaperPlane } from 'react-icons/fa';
import { db } from '../firebase';
import type { Subscription } from '../subscription';
import { getActivePlan } from '../subscription';
import { chatAssistant } from '../lib/openai';
import { AiLimitError } from '../lib/openai';
import Paywall from './Paywall';
import './AiChat.css';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
}

interface AiChatProps {
  user: User | null;
  language: 'en' | 'ru';
  subscription?: Subscription | null;
  onBack: () => void;
}

// ── i18n ──────────────────────────────────────────────────────────────────────

const T = {
  en: {
    title:        'AI Assistant',
    placeholder:  'Ask anything…',
    send:         'Send',
    premiumOnly:  'AI chat is available in Premium plan',
    rateLimitMsg: (s: number) => `Please wait ${s}s before sending another message.`,
    limitMsg:     (u: number, l: number) => `Monthly limit reached: ${u}/${l} requests used.`,
    errorMsg:     'Something went wrong. Try again.',
    thinking:     'Thinking…',
  },
  ru: {
    title:        'AI-ассистент',
    placeholder:  'Спроси что угодно…',
    send:         'Отправить',
    premiumOnly:  'AI-чат доступен в Premium тарифе',
    rateLimitMsg: (s: number) => `Подождите ${s}с перед следующим сообщением.`,
    limitMsg:     (u: number, l: number) => `Лимит месяца: ${u}/${l} запросов.`,
    errorMsg:     'Что-то пошло не так. Попробуйте ещё раз.',
    thinking:     'Думаю…',
  },
};

// ── Component ─────────────────────────────────────────────────────────────────

const AiChat: React.FC<AiChatProps> = ({ user, language, subscription, onBack }) => {
  const t    = T[language];
  const plan = getActivePlan(subscription ?? null);

  const [messages,     setMessages]     = useState<ChatMsg[]>([]);
  const [input,        setInput]        = useState('');
  const [sending,      setSending]      = useState(false);
  const [errorMsg,     setErrorMsg]     = useState<string | null>(null);
  const [showPaywall,  setShowPaywall]  = useState(false);

  const bottomRef  = useRef<HTMLDivElement>(null);
  const inputRef   = useRef<HTMLTextAreaElement>(null);

  const isPremium = plan === 'premium';

  // ── Load history from Firestore ───────────────────────────────────────────

  useEffect(() => {
    if (!user || !isPremium) return;
    const q = query(
      collection(db, 'users', user.uid, 'aiChats'),
      orderBy('createdAt', 'asc'),
      firestoreLimit(50),
    );
    const unsub = onSnapshot(q, snap => {
      setMessages(snap.docs.map(d => {
        const data = d.data();
        return {
          id:        d.id,
          role:      data.role as 'user' | 'assistant',
          content:   data.content as string,
          createdAt: (data.createdAt as Timestamp)?.toDate?.() ?? new Date(),
        };
      }));
    }, () => {});
    return unsub;
  }, [user, isPremium]);

  // ── Auto-scroll ───────────────────────────────────────────────────────────

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Send ──────────────────────────────────────────────────────────────────

  const handleSend = useCallback(async () => {
    if (!user || !input.trim() || sending || !isPremium) return;

    const text = input.trim();
    setInput('');
    setErrorMsg(null);
    setSending(true);

    const optimisticUser: ChatMsg = {
      id:        `optimistic-${Date.now()}`,
      role:      'user',
      content:   text,
      createdAt: new Date(),
    };
    setMessages(prev => [...prev, optimisticUser]);

    try {
      const history = messages.slice(-10).map(m => ({ role: m.role, content: m.content }));
      const resp    = await chatAssistant(text, history, user.uid, plan);

      await addDoc(collection(db, 'users', user.uid, 'aiChats'), {
        role: 'user', content: text, createdAt: serverTimestamp(),
      });
      await addDoc(collection(db, 'users', user.uid, 'aiChats'), {
        role: 'assistant', content: resp.message, createdAt: serverTimestamp(),
      });
    } catch (err) {
      setMessages(prev => prev.filter(m => m.id !== optimisticUser.id));
      if (err instanceof AiLimitError) {
        if (err.type === 'rate_limit') {
          const secs = Math.ceil((err.retryAfterMs ?? 10000) / 1000);
          setErrorMsg(t.rateLimitMsg(secs));
        } else if (err.type === 'monthly_limit') {
          setErrorMsg(t.limitMsg(err.used ?? 0, err.limit ?? 100));
        } else {
          setShowPaywall(true);
        }
      } else {
        setErrorMsg(t.errorMsg);
      }
    } finally {
      setSending(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [user, input, sending, isPremium, messages, plan, t]);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="ai-chat">

      {showPaywall && (
        <Paywall
          featureName={language === 'ru' ? 'AI-чат' : 'AI chat'}
          language={language}
          onClose={() => setShowPaywall(false)}
          onUpgrade={() => { setShowPaywall(false); onBack(); }}
        />
      )}

      <div className="ai-chat__toolbar">
        <button className="ai-chat__back-btn" onClick={onBack} type="button">
          <FaArrowLeft /> {language === 'ru' ? 'Назад' : 'Back'}
        </button>
        <span className="ai-chat__title">{t.title}</span>
      </div>

      {/* Plan gate */}
      {!isPremium ? (
        <div className="ai-chat__gate">
          <div className="ai-chat__gate-icon" aria-hidden="true">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
              <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"
                fill="#a29bfe" />
            </svg>
          </div>
          <p className="ai-chat__gate-text">{t.premiumOnly}</p>
          <button
            type="button"
            className="ai-chat__gate-btn"
            onClick={() => setShowPaywall(true)}
          >
            {language === 'ru' ? 'Перейти на Premium' : 'Upgrade to Premium'}
          </button>
        </div>
      ) : (
        <>
          {/* Messages */}
          <div className="ai-chat__messages">
            {messages.map(msg => (
              <div key={msg.id} className={`ai-chat__bubble ai-chat__bubble--${msg.role}`}>
                <div className="ai-chat__bubble-content">{msg.content}</div>
              </div>
            ))}
            {sending && (
              <div className="ai-chat__bubble ai-chat__bubble--assistant">
                <div className="ai-chat__typing">
                  <span /><span /><span />
                </div>
              </div>
            )}
            {errorMsg && (
              <div className="ai-chat__error">{errorMsg}</div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="ai-chat__input-row">
            <textarea
              ref={inputRef}
              className="ai-chat__input"
              placeholder={t.placeholder}
              value={input}
              rows={1}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
            />
            <button
              type="button"
              className="ai-chat__send-btn"
              onClick={handleSend}
              disabled={!input.trim() || sending}
              aria-label={t.send}
            >
              <FaPaperPlane />
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default AiChat;
