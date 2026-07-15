import assert from 'node:assert/strict';
import test from 'node:test';

import { measurablyUnchanged } from '../src/runtime.js';

test('fallback safety requires two available equal fingerprints', () => {
  assert.equal(measurablyUnchanged('same', 'same'), true);
  assert.equal(measurablyUnchanged('before', 'after'), false);
  assert.equal(measurablyUnchanged(undefined, undefined), false);
  assert.equal(measurablyUnchanged('known', undefined), false);
  assert.equal(measurablyUnchanged(undefined, 'known'), false);
});
