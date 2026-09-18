'use strict';

// Single source of truth for ENMA backend defaults.
// All consumers should import from here rather than hardcoding strings.

const DEFAULT_CURRENCY   = 'RUB';

// Fixed system budget currency. Balance, income, expenses, categories,
// cashflow, goals, insights and all analytics are ALWAYS expressed in it.
// NOT the same thing as user.currency, which is only the currency new
// operations are entered in when none is named explicitly.
const HOME_BUDGET_CURRENCY = 'RUB';
const SUPPORTED_CURRENCIES = ['RUB', 'USD', 'EUR', 'BYN', 'CNY'];

const CURRENCY_SYMBOLS = { RUB: '₽', USD: '$', EUR: '€', BYN: 'Br', CNY: '¥' };

function currencySymbol(currency) {
  return CURRENCY_SYMBOLS[currency] || currency;
}

module.exports = { HOME_BUDGET_CURRENCY, DEFAULT_CURRENCY, SUPPORTED_CURRENCIES, CURRENCY_SYMBOLS, currencySymbol };
