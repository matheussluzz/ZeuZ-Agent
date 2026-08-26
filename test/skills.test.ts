import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCatalogIndex } from '../src/skill-registry/index.js';
import { PortableSkillRegistry } from '../src/skill-registry/registry.js';
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

test('AIHero import has 25 pinned, enabled skill records', async () => {
  const index = await buildCatalogIndex();
  const aihero = index.skills.filter((skill) => skill.zeuz.namespace === 'zeuz/aihero');

  assert.equal(aihero.length, 25);
  assert.ok(aihero.every((skill) => skill.source.canonicalUrl === 'https://github.com/mattpocock/skills'));
  assert.ok(aihero.every((skill) => skill.source.revision === '6654f6b60cd9d5be8b54c6fafe44346dabeb3b76'));
  assert.ok(aihero.every((skill) => skill.zeuz.trust === 'enabled' && skill.zeuz.enablement === 'enabled'));
  assert.ok(aihero.every((skill) => (skill.zeuz.triggers?.length ?? 0) > 0));
});

test('AIHero semantic and explicit triggers inject the matching skill bodies', async () => {
  const registry = new PortableSkillRegistry();
  const debugContext = await registry.contextFor('Diagnose this failing and slow test.');
  assert.match(debugContext ?? '', /<skill name="diagnosing-bugs"/);

  const reviewContext = await registry.contextFor('/code-review');
  assert.match(reviewContext ?? '', /<skill name="code-review"/);

  const implicitRouterContext = await registry.contextFor('Please use grill-with-docs for this design.');
  assert.doesNotMatch(implicitRouterContext ?? '', /<skill name="grill-with-docs"/);

  const grillContext = await registry.contextFor('/grill-with-docs');
  assert.match(grillContext ?? '', /<skill name="grill-with-docs"/);
  assert.match(grillContext ?? '', /<skill name="grilling"/);
  assert.match(grillContext ?? '', /<skill name="domain-modeling"/);
});
