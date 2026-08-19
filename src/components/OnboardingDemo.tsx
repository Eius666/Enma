import React, { useState } from 'react';
import './OnboardingDemo.css';

interface OnboardingDemoProps {
  language: 'en' | 'ru';
  onStartTrial: () => void;
  onDismiss: () => void;
  trialLoading?: boolean;
}

const DEMO_TRANSACTIONS = {
  en: [
    { category: 'Food',          amount: -850,   emoji: '🍔' },
    { category: 'Salary',        amount: 85000,  emoji: '💰' },
    { category: 'Transport',     amount: -350,   emoji: '🚌' },
    { category: 'Entertainment', amount: -1200,  emoji: '🎮' },
    { category: 'Groceries',     amount: -2300,  emoji: '🛒' },
  ],
  ru: [
    { category: 'Еда',            amount: -850,   emoji: '🍔' },
    { category: 'Зарплата',       amount: 85000,  emoji: '💰' },
    { category: 'Транспорт',      amount: -350,   emoji: '🚌' },
    { category: 'Развлечения',    amount: -1200,  emoji: '🎮' },
    { category: 'Продукты',       amount: -2300,  emoji: '🛒' },
  ],
};

const DEMO_INSIGHT = {
  en: {
    heading:    'AI Analysis Preview',
    summary:    'You spent 32% of income on food and entertainment this month.',
    tip:        'Reduce entertainment by 20% to save ≈ 2 400 ₽ extra per month.',
    topCat:     'Top spend: Groceries',
    disclaimer: 'This is demo data. Your real analysis will be based on your actual transactions.',
    ctaBtn:     'Try with my data — 7 days free',
    dismiss:    'Skip for now',
  },
  ru: {
    heading:    'Предпросмотр AI-анализа',
    summary:    'В этом месяце вы потратили 32% дохода на еду и развлечения.',
    tip:        'Сократите развлечения на 20% — сэкономите ≈ 2 400 ₽ в месяц.',
    topCat:     'Главная трата: Продукты',
    disclaimer: 'Это демо-данные. Ваш реальный анализ будет на основе ваших транзакций.',
    ctaBtn:     'Попробовать на моих данных — 7 дней бесплатно',
    dismiss:    'Пропустить',
  },
};

const OnboardingDemo: React.FC<OnboardingDemoProps> = ({
  language,
  onStartTrial,
  onDismiss,
  trialLoading = false,
}) => {
  const [analysisVisible, setAnalysisVisible] = useState(false);
  const t  = DEMO_INSIGHT[language];
  const tx = DEMO_TRANSACTIONS[language];

  return (
    <div className="onboarding-demo">
      <div className="onboarding-demo__header">
        <span className="onboarding-demo__icon" aria-hidden="true">✨</span>
        <h2 className="onboarding-demo__title">{t.heading}</h2>
      </div>

      {/* Demo transaction list */}
      <ul className="onboarding-demo__tx-list">
        {tx.map(item => (
          <li key={item.category} className="onboarding-demo__tx">
            <span className="onboarding-demo__tx-emoji" aria-hidden="true">{item.emoji}</span>
            <span className="onboarding-demo__tx-cat">{item.category}</span>
            <span className={`onboarding-demo__tx-amount${item.amount > 0 ? ' onboarding-demo__tx-amount--income' : ''}`}>
              {item.amount > 0 ? '+' : ''}{item.amount.toLocaleString()} ₽
            </span>
          </li>
        ))}
      </ul>

      {/* Collapsed AI insight — expand on tap */}
      {!analysisVisible ? (
        <button
          type="button"
          className="onboarding-demo__reveal-btn"
          onClick={() => setAnalysisVisible(true)}
        >
          {language === 'ru' ? 'Показать AI-анализ' : 'Show AI analysis'}
        </button>
      ) : (
        <div className="onboarding-demo__insight">
          <p className="onboarding-demo__insight-summary">{t.summary}</p>
          <div className="onboarding-demo__insight-tip">
            <span aria-hidden="true">💡</span> {t.tip}
          </div>
          <span className="onboarding-demo__insight-top">{t.topCat}</span>
        </div>
      )}

      <p className="onboarding-demo__disclaimer">{t.disclaimer}</p>

      <button
        type="button"
        className="onboarding-demo__cta"
        onClick={onStartTrial}
        disabled={trialLoading}
      >
        {trialLoading ? '…' : t.ctaBtn}
      </button>

      <button
        type="button"
        className="onboarding-demo__dismiss"
        onClick={onDismiss}
      >
        {t.dismiss}
      </button>
    </div>
  );
};

export default OnboardingDemo;
