import assert from 'node:assert/strict';
import test from 'node:test';

import { SkillRegistry } from '../src/skills.js';

test('Metis always brings Medusa into the active skill context', async () => {
  const context = await new SkillRegistry().contextFor('Use Metis for deep research');
  assert.match(context ?? '', /<skill name="metis"/);
  assert.match(context ?? '', /<skill name="medusa"/);
});

test('Athena brings Prometeu and Clio into the active skill context', async () => {
  const context = await new SkillRegistry().contextFor('Query AWS Athena for this dataset');
  assert.match(context ?? '', /<skill name="atena"/);
  assert.match(context ?? '', /<skill name="prometeu"/);
  assert.match(context ?? '', /<skill name="clio"/);
});
