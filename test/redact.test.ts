import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizedChildEnvironment } from '../src/env.js';
import { redactSecrets } from '../src/redact.js';

test('redacts configured secret values and token-shaped strings', () => {
  const previous = process.env.TEST_API_KEY;
  const configuredSecret = ['super', 'secret', 'value', '123'].join('-');
  process.env.TEST_API_KEY = configuredSecret;
  try {
    const nvidiaToken = ['nvapi', 'AbCdEf1234567890'].join('-');
    const githubToken = ['gho', '12345678901234567890'].join('_');
    const anthropicToken = ['sk', 'ant', 'api03', 'AbCdEf123456789012345'].join('-');
    const awsAccessKey = ['AKIA', '1234567890ABCDEF'].join('');
    const result = redactSecrets(`a=${configuredSecret} b=${nvidiaToken} c=${githubToken} d=${anthropicToken} e=${awsAccessKey}`);
    assert.doesNotMatch(result, /super-secret-value-123/);
    assert.doesNotMatch(result, /nvapi-/);
    assert.doesNotMatch(result, /gho_/);
    assert.doesNotMatch(result, /sk-ant-/);
    assert.doesNotMatch(result, /AKIA/);
    assert.match(result, /redacted/);
  } finally {
    if (previous === undefined) delete process.env.TEST_API_KEY;
    else process.env.TEST_API_KEY = previous;
  }
});

test('sanitized child environments remove common credential variables', () => {
  const previous = process.env.AWS_ACCESS_KEY_ID;
  process.env.AWS_ACCESS_KEY_ID = ['AKIA', '1234567890ABCDEF'].join('');
  try {
    assert.equal(sanitizedChildEnvironment().AWS_ACCESS_KEY_ID, undefined);
  } finally {
    if (previous === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = previous;
  }
});
