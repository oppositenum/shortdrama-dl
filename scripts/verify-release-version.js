'use strict';

const fs = require('node:fs');
const path = require('node:path');

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function verifyReleaseVersion({root, tag, actionVersion}) {
  if (!tag) {
    throw new Error('missing release tag argument or RELEASE_TAG');
  }

  const readJson = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  const packageJson = readJson('package.json');
  const packageLock = readJson('package-lock.json');
  const manifest = readJson('.release-please-manifest.json');
  const version = packageJson.version;

  if (packageJson.name !== 'shortdrama-dl') {
    throw new Error(`package name is ${JSON.stringify(packageJson.name)}, expected "shortdrama-dl"`);
  }
  if (typeof version !== 'string' || !semverPattern.test(version)) {
    throw new Error(`package.json contains an invalid SemVer version: ${JSON.stringify(version)}`);
  }
  if (packageLock.name !== packageJson.name || packageLock.version !== version) {
    throw new Error('package-lock.json root name/version does not match package.json');
  }
  if (!packageLock.packages || !packageLock.packages['']) {
    throw new Error('package-lock.json does not contain a root package entry');
  }
  if (
    packageLock.packages[''].name !== packageJson.name ||
    packageLock.packages[''].version !== version
  ) {
    throw new Error('package-lock.json packages[""] name/version does not match package.json');
  }
  if (manifest['.'] !== version) {
    throw new Error(
      `release manifest version is ${JSON.stringify(manifest['.'])}, expected ${version}`,
    );
  }
  if (tag !== `v${version}`) {
    throw new Error(`tag is ${JSON.stringify(tag)}, expected "v${version}"`);
  }
  if (actionVersion && actionVersion !== version) {
    throw new Error(`Release Please output is ${JSON.stringify(actionVersion)}, expected ${version}`);
  }

  return {name: packageJson.name, version, tag};
}

if (require.main === module) {
  try {
    const result = verifyReleaseVersion({
      root: path.resolve(__dirname, '..'),
      tag: process.argv[2] || process.env.RELEASE_TAG,
      actionVersion: process.argv[3] || process.env.RELEASE_VERSION,
    });
    console.log(`Release identity verified: ${result.name} ${result.version} (${result.tag})`);
  } catch (error) {
    console.error(`Release version check failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {verifyReleaseVersion};
