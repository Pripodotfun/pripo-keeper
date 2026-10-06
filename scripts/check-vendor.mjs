import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const provenance = JSON.parse(await readFile(new URL('../vendor/provenance.json', import.meta.url), 'utf8'));
const archive = await readFile(new URL(`../vendor/${provenance.archive}`, import.meta.url));
assert.equal(createHash('sha256').update(archive).digest('hex'), provenance.sha256, 'SDK archive differs from recorded source release');
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
assert.equal(lock.packages['node_modules/@pripo/sdk'].integrity,
  `sha512-${createHash('sha512').update(archive).digest('base64')}`, 'SDK lockfile integrity mismatch');
const manifest = JSON.parse(await readFile(new URL('../node_modules/@pripo/sdk/abi-manifest.json', import.meta.url), 'utf8'));
assert.equal(manifest.commit, provenance.contractsCommit, 'Installed ABI manifest differs from release pin');
console.log(`Verified SDK ${provenance.version} from ${provenance.sdkCommit}`);
