import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { rollChangelog } from '../.github/scripts/changelog-release.mjs';

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- Something new.

[Unreleased]: https://github.com/prohand/gladys-dooyaconnector/commits/main
`;

test('the Unreleased section moves under the released version', () => {
  const rolled = rollChangelog(CHANGELOG, '1.0.0', '2026-10-16');
  assert.match(
    rolled,
    /## \[Unreleased\]\n\n## \[1\.0\.0\] - 2026-10-16\n\n### Added\n\n- Something new\./,
  );
  assert.match(rolled, /\[Unreleased\]: \S+\/compare\/v1\.0\.0\.\.\.HEAD/);
  assert.match(rolled, /\[1\.0\.0\]: \S+\/releases\/tag\/v1\.0\.0/);
});

test('the next release compares with the previous tag', () => {
  const once = rollChangelog(CHANGELOG, '1.0.0', '2026-10-16');
  const twice = rollChangelog(once, '1.0.1', '2026-10-17');
  assert.match(twice, /## \[1\.0\.1\] - 2026-10-17\n\n- Maintenance release/);
  assert.match(twice, /\[1\.0\.1\]: \S+\/compare\/v1\.0\.0\.\.\.v1\.0\.1/);
});

test('the real changelog has an Unreleased section the workflow can roll', async () => {
  const text = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.match(text, /^## \[Unreleased\]$/m);
  assert.match(text, /^\[Unreleased\]: https:\/\/github\.com\/prohand\/gladys-dooyaconnector\//m);
});
