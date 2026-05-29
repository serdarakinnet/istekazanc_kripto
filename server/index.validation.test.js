const assert = require('node:assert/strict');
const test = require('node:test');

const { __test } = require('./index');

test('assertQuoteAssetTry: rejects non-TRY', () => {
  assert.throws(() => __test.assertQuoteAssetTry('USDT'), { message: /TRY/ });
  assert.doesNotThrow(() => __test.assertQuoteAssetTry('TRY'));
  assert.doesNotThrow(() => __test.assertQuoteAssetTry(' try '));
});

test('assertSymbolTryPair: rejects non-TRY pairs', () => {
  assert.throws(() => __test.assertSymbolTryPair('BTCUSDT'), { message: /TRY/ });
  assert.doesNotThrow(() => __test.assertSymbolTryPair('BTCTRY'));
});

test('validateBinanceKlinesArray: requires array of official kline arrays', () => {
  assert.equal(__test.validateBinanceKlinesArray(null).ok, false);
  assert.equal(__test.validateBinanceKlinesArray([]).ok, false);
  assert.equal(__test.validateBinanceKlinesArray([{}]).ok, false);
  assert.equal(__test.validateBinanceKlinesArray([[0, '1', '2', '1', '1.5']]).ok, false);
});

test('validateBinanceKlinesArray: accepts valid klines', () => {
  const klines = [
    [1710000000000, '10', '12', '9', '11', '100', 1710003600000, '0', 0, '0', '0', '0'],
    [1710003600000, '11', '13', '10', '12', '120', 1710007200000, '0', 0, '0', '0', '0'],
  ];
  const r = __test.validateBinanceKlinesArray(klines);
  assert.equal(r.ok, true);
});

test('validateBinanceKlinesArray: rejects inconsistent OHLC', () => {
  const klines = [
    [1710000000000, '10', '9', '9', '11', '100', 1710003600000, '0', 0, '0', '0', '0'],
  ];
  const r = __test.validateBinanceKlinesArray(klines);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /OHLC/);
});
