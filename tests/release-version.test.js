'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {verifyReleaseVersion} = require('../scripts/verify-release-version');

function createReleaseFiles(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shortdrama-release-version-'));
  const packageJson = {
    name: 'shortdrama-dl',
    version: '1.0.0',
    ...overrides.packageJson,
  };
  const packageLock = {
    name: 'shortdrama-dl',
    version: '1.0.0',
    packages: {
      '': {
        name: 'shortdrama-dl',
        version: '1.0.0',
      },
    },
    ...overrides.packageLock,
  };
  const manifest = overrides.manifest || {'.': '1.0.0'};

  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageJson));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(packageLock));
  fs.writeFileSync(path.join(root, '.release-please-manifest.json'), JSON.stringify(manifest));
  return root;
}

test('release identity accepts the first v1.0.0 Release Please state', (t) => {
  const root = createReleaseFiles();
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));

  assert.deepEqual(
    verifyReleaseVersion({root, tag: 'v1.0.0', actionVersion: '1.0.0'}),
    {name: 'shortdrama-dl', version: '1.0.0', tag: 'v1.0.0'},
  );
});

test('release identity rejects an unreleased empty manifest', (t) => {
  const root = createReleaseFiles({manifest: {}});
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));

  assert.throws(
    () => verifyReleaseVersion({root, tag: 'v1.0.0', actionVersion: '1.0.0'}),
    /release manifest version is undefined, expected 1\.0\.0/,
  );
});

test('release identity rejects a tag that differs from package.json', (t) => {
  const root = createReleaseFiles();
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));

  assert.throws(
    () => verifyReleaseVersion({root, tag: 'v1.0.1', actionVersion: '1.0.0'}),
    /tag is "v1\.0\.1", expected "v1\.0\.0"/,
  );
});

test('release identity rejects a package-lock root version mismatch', (t) => {
  const root = createReleaseFiles({packageLock: {version: '1.0.1'}});
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));

  assert.throws(
    () => verifyReleaseVersion({root, tag: 'v1.0.0', actionVersion: '1.0.0'}),
    /package-lock\.json root name\/version does not match package\.json/,
  );
});
