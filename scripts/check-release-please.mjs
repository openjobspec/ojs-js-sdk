import { readFileSync } from 'node:fs';

const config = readJson('release-please-config.json');
const manifest = readJson('.release-please-manifest.json');
verify(config, manifest, ['package.json']);

function verify(releaseConfig, releaseManifest, managedFiles) {
  if (hasKey(releaseConfig, 'release-as')) {
    throw new Error('release-please config must not contain persistent release-as');
  }
  const packageConfig = releaseConfig.packages?.['.'];
  if (!packageConfig?.['bump-minor-pre-major']) {
    throw new Error('bump-minor-pre-major must be enabled');
  }
  const last = parse(releaseManifest['.']);
  const next = `${last.major}.${last.minor + 1}.0`;
  const postReleaseNext = `${last.major}.${last.minor + 2}.0`;
  if (postReleaseNext === next) {
    throw new Error('post-release version calculation is stuck');
  }
  for (const file of managedFiles) {
    const metadata = readJson(file);
    if (![releaseManifest['.'], next].includes(metadata.version)) {
      throw new Error(`${file} version ${metadata.version} is not last release or next minor ${next}`);
    }
  }
  console.log(`Release Please: ${releaseManifest['.']} -> ${next} -> ${postReleaseNext}`);
}

function hasKey(value, key) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([entryKey, entryValue]) => entryKey === key || hasKey(entryValue, key),
  );
}

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Invalid manifest version: ${version}`);
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function readJson(file) {
  return JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
}
