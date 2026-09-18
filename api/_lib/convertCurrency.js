'use strict';

// Pure currency conversion — mirrors src/utils/convertCurrency.ts.
// rates are units-of-currency-per-1-RUB (e.g. { RUB: 1, USD: 0.011 }).
function convertCurrency(amount, from, to, rates) {
  if (from === to) return amount;
  const fromRate = rates[from] ?? 1;
  const toRate   = rates[to]   ?? 1;
  return (amount / fromRate) * toRate;
}

module.exports = { convertCurrency };
