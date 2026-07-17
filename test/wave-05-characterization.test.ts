/**
 * Wave 05 baseline characterization — green checkpoint against commit c6396f3.
 * Source-structure assertions read the frozen baseline; runtime assertions describe pre-registry behavior.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SkillRegistry } from '../src/skills.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = 'c6396f3efb3184d4952068f6da80759a2f3bff05';
const skillsSource = execFileSync('git', ['show', `${BASELINE}:src/skills.ts`], { cwd: repositoryRoot, encoding: 'utf8' });

test('[wave05 characterization] hard-coded SKILL_TRIGGERS regex map exists for eight pantheon skills', () => {
  assert.match(skillsSource, /const SKILL_TRIGGERS: Record<string, RegExp>/);
  for (const name of ['medusa', 'hermes', 'hefesto', 'atena', 'clio', 'prometeu', 'argos', 'metis']) {
    assert.match(skillsSource, new RegExp(`${name}:`));
  }
});

test('[wave05 characterization] contextFor silently truncates to three selected skills', () => {
  assert.match(skillsSource, /selected\.slice\(0, 3\)/);
});

test('[wave05 characterization] Metis and Athena dependencies are special-cased in TypeScript', () => {
  assert.match(skillsSource, /selected\.includes\('metis'\)/);
  assert.match(skillsSource, /selected\.includes\('atena'\)/);
  assert.doesNotMatch(skillsSource, /zeuz\.manifest|dependencies:/);
});

test('[wave05 characterization] list discovers pantheon directories under skills/', async () => {
  const entries = await readdir(join(repositoryRoot, 'skills'), { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const listed = await new SkillRegistry().list();
  assert.deepEqual(listed.map((skill) => skill.name).sort(), directories.sort());
});

test('[wave05 characterization] baseline activation injected full SKILL.md bodies', () => {
  const sample = readFileSync(join(repositoryRoot, 'skills', 'medusa', 'SKILL.md'), 'utf8');
  assert.match(sample, /^---\nname: medusa/);
  assert.match(sample, /^# Medusa/m);
});

test('[wave05 characterization] baseline missing skill file became unavailable tag without trust lifecycle', () => {
  assert.match(skillsSource, /unavailable="true"/);
  assert.doesNotMatch(skillsSource, /quarantined|trustState|trust_state/);
});

test('[wave05 characterization] baseline skills.ts had no canonical IDs, provenance, sync, or install controls', () => {
  for (const token of ['canonical', 'provenance', 'digest', 'quarantine', 'skill install', 'skill sync', 'namespace', 'license']) {
    assert.doesNotMatch(skillsSource, new RegExp(token, 'i'));
  }
});
