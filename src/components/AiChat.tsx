import React, { useEffect, useRef, useState } from 'react';
import { FaPaperPlane, FaRobot, FaLock } from 'react-icons/fa';
import type { User } from 'firebase/auth';
import './AiChat.css';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  provider?: string;
}

interface AiChatProps {
  user: User;
  language: 'en' | 'ru';
  onGoToSubscription?: () => void;
}

const T = {
  en: {
    title: 'AI Assistant',
    placeholder: 'Ask anything...',
    send: 'Send',
    emptyHint: 'Ask a question or describe a financial operation.',
    subscriptionTitle: 'Subscription required',
    subscriptionHint: 'Subscribe to use the AI assistant.',
    subscriptionBtn: 'Go to subscription',
    errorMsg: 'The AI assistant is temporarily unavailable.',
    thinking: 'Thinking...',
  },
  ru: {
    title: 'AI-ассистент',
    placeholder: 'Задайте вопрос...',
    send: 'Отправить',
    emptyHint: 'Задайте вопрос или опишите финансовую операцию.',
    subscriptionTitle: 'Требуется подписка',
    subscriptionHint: 'Оформите подписку, чтобы использовать AI-ассистент.',
    subscriptionBtn: 'Оформить подписку',
    errorMsg: 'AI-ассистент временно недоступен.',
    thinking: 'Думаю...',
  },
};

const AiChat: React.FC<AiChatProps> = ({ user, language, onGoToSubscription }) => {
  const t = T[language];

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [subscriptionRequired, setSubscriptionRequired] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    const userMsg: Message = { role: 'user', content: trimmed };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.uid,
          messages: history.map(m => ({ role: m.role, content: m.content })),
        }),
      });

      if (res.status === 403) {
        setSubscriptionRequired(true);
        setMessages(prev => prev.slice(0, -1)); // remove the user message
        return;
      }

      const data: { response?: string; provider?: string; error?: string } = await res.json().catch(() => ({}));

      if (!res.ok || !data.response) {
        setMessages(prev => [...prev, { role: 'assistant', content: t.errorMsg }]);
        return;
      }

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.response!,
        provider: data.provider,
      }]);
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: t.errorMsg }]);
    } finally {
      setLoading(false);
      // Restore focus
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (subscriptionRequired) {
    return (
      <div className="ai-chat ai-chat--paywall">
        <div className="ai-chat__paywall-icon">
          <FaLock />
        </div>
        <p className="ai-chat__paywall-title">{t.subscriptionTitle}</p>
        <p className="ai-chat__paywall-hint">{t.subscriptionHint}</p>
        {onGoToSubscription && (
          <button className="ai-chat__paywall-btn" onClick={onGoToSubscription} type="button">
            {t.subscriptionBtn}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="ai-chat">
      {/* ── Message list ── */}
      <div className="ai-chat__messages">
        {messages.length === 0 && !loading && (
          <div className="ai-chat__empty">
            <span className="ai-chat__empty-icon"><FaRobot /></span>
            <p className="ai-chat__empty-hint">{t.emptyHint}</p>
          </div>
        )}

        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`ai-chat__bubble ai-chat__bubble--${msg.role}`}
          >
            <span className="ai-chat__bubble-text">{msg.content}</span>
            {msg.provider && (
              <span className="ai-chat__bubble-provider">{msg.provider}</span>
            )}
          </div>
        ))}

        {loading && (
          <div className="ai-chat__bubble ai-chat__bubble--assistant ai-chat__bubble--loading">
            <span className="ai-chat__typing">
              <span /><span /><span />
            </span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* ── Input area ── */}
      <div className="ai-chat__input-row">
        <textarea
          ref={inputRef}
          className="ai-chat__input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t.placeholder}
          rows={1}
          disabled={loading}
        />
        <button
          className="ai-chat__send-btn"
          onClick={handleSend}
          disabled={!input.trim() || loading}
          type="button"
          aria-label={t.send}
        >
          <FaPaperPlane />
        </button>
      </div>
    </div>
  );
};

export default AiChat;
