'use strict';

// Single source of truth for ENMA backend defaults.
// All consumers should import from here rather than hardcoding strings.

const DEFAULT_CURRENCY   = 'RUB';
const SUPPORTED_CURRENCIES = ['RUB', 'USD', 'EUR', 'BYN', 'CNY'];

const CURRENCY_SYMBOLS = { RUB: '₽', USD: '$', EUR: '€', BYN: 'Br', CNY: '¥' };

function currencySymbol(currency) {
  return CURRENCY_SYMBOLS[currency] || currency;
}

module.exports = { DEFAULT_CURRENCY, SUPPORTED_CURRENCIES, CURRENCY_SYMBOLS, currencySymbol };
