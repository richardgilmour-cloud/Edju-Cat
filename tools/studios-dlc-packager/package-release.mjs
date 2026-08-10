import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import archiver from 'archiver';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const requiredEnvironment = [
  'RELEASE_ID', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_D1_DATABASE_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
  'GITHUB_REPOSITORY', 'GITHUB_TOKEN'
];
for (const name of requiredEnvironment) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const releaseId = process.env.RELEASE_ID;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;
const studiosBucket = process.env.STUDIOS_BUCKET || 'edju-cat-studios-assets';
const dlcBucket = process.env.DLC_BUCKET || 'edjucat-modules';
const githubRepository = process.env.GITHUB_REPOSITORY;
const githubToken = process.env.GITHUB_TOKEN;
const githubBranch = process.env.GITHUB_REF_NAME || 'main';
const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
const s3 = new S3Client({
  region: 'auto', endpoint,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

const platformFiles = {
  'platform-reward-box-available': 'shared/platform/map/reward-box.png',
  'platform-reward-box-locked': 'shared/platform/map/reward-box-locked.png',
  'platform-reward-box-open': 'shared/platform/map/reward-box-open.png'
};

async function d1(sql, params = []) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ sql, params })
    }
  );
  const result = await response.json();
  if (!response.ok || !result.success || !result.result?.[0]?.success) {
    throw new Error(`D1 request failed: ${JSON.stringify(result.errors || result)}`);
  }
  return result.result[0].results || [];
}

async function objectText(bucket, key) {
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!object.Body) throw new Error(`R2 object is empty: ${key}`);
  return object.Body.transformToString('utf-8');
}

function safePath(root, relativePath) {
  if (!relativePath || relativePath.includes('\\') || relativePath.startsWith('/') || relativePath.split('/').includes('..')) {
    throw new Error(`Unsafe package path: ${relativePath}`);
  }
  const absolute = path.resolve(root, ...relativePath.split('/'));
  if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`Package path escapes its root: ${relativePath}`);
  return absolute;
}

async function hashFile(file, algorithm) {
  const hash = createHash(algorithm);
  await pipeline(createReadStream(file), new Transform({
    transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); }
  }), new Transform({ transform(_chunk, _encoding, callback) { callback(); } }));
  return hash.digest('hex');
}

async function downloadVerified(key, destination, expectedBytes, expectedSha256) {
  await mkdir(path.dirname(destination), { recursive: true });
  const object = await s3.send(new GetObjectCommand({ Bucket: studiosBucket, Key: key }));
  if (!object.Body) throw new Error(`A selected file is missing from R2: ${key}`);
  const hash = createHash('sha256');
  let bytes = 0;
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  await pipeline(object.Body, verifier, createWriteStream(destination, { flags: 'wx' }));
  if (bytes !== expectedBytes) throw new Error(`Size mismatch while downloading ${key}.`);
  if (expectedSha256 && hash.digest('hex') !== expectedSha256.toLowerCase()) {
    throw new Error(`SHA-256 mismatch while downloading ${key}.`);
  }
}

async function createZip(root, destination, relativePaths) {
  await new Promise((resolve, reject) => {
    const output = createWriteStream(destination, { flags: 'wx' });
    const zip = archiver('zip', { store: true });
    output.on('close', resolve);
    output.on('error', reject);
    zip.on('warning', reject);
    zip.on('error', reject);
    zip.pipe(output);
    for (const relativePath of [...relativePaths].sort((a, b) => a.localeCompare(b, 'en'))) {
      zip.file(safePath(root, relativePath), { name: relativePath, date: new Date('2000-01-01T00:00:00Z'), mode: 0o644 });
    }
    zip.finalize().catch(reject);
  });
}

async function setFailed(message) {
  await d1(
    "UPDATE module_releases SET status='failed', error_message=?, updated_at=? WHERE id=?",
    [message.slice(0, 1000), new Date().toISOString(), releaseId]
  ).catch((error) => console.error('Unable to report failed build:', error));
}

function compareVersions(left, right) {
  const parse = (value) => value.split('-', 1)[0].split('.').map(Number);
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

async function publishCatalogDescriptor(descriptor) {
  const catalogPath = 'content-packs/catalog.json';
  const endpoint = `https://api.github.com/repos/${githubRepository}/contents/${catalogPath}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${githubToken}`,
    'User-Agent': 'edju-cat-studios-packager',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  const currentResponse = await fetch(`${endpoint}?ref=${encodeURIComponent(githubBranch)}`, { headers });
  if (!currentResponse.ok) {
    throw new Error(`Unable to read the app content catalogue (${currentResponse.status}).`);
  }
  const currentFile = await currentResponse.json();
  const catalog = JSON.parse(Buffer.from(currentFile.content, 'base64').toString('utf8'));
  if (catalog.schemaVersion !== 1 || !catalog.packs || typeof catalog.packs !== 'object') {
    throw new Error('The app content catalogue has an unsupported structure.');
  }
  const currentDescriptor = catalog.packs[descriptor.packId];
  if (currentDescriptor?.version && compareVersions(currentDescriptor.version, descriptor.version) > 0) {
    console.log(`Catalogue already contains newer ${descriptor.packId} v${currentDescriptor.version}; leaving it unchanged.`);
    return;
  }
  const nextCatalog = {
    ...catalog,
    generatedAt: new Date().toISOString(),
    packs: { ...catalog.packs, [descriptor.packId]: descriptor }
  };
  const updateResponse = await fetch(endpoint, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Publish ${descriptor.packId} v${descriptor.version}`,
      content: Buffer.from(`${JSON.stringify(nextCatalog, null, 2)}\n`).toString('base64'),
      sha: currentFile.sha,
      branch: githubBranch
    })
  });
  if (!updateResponse.ok) {
    const detail = await updateResponse.text();
    throw new Error(`Unable to publish the app content catalogue (${updateResponse.status}): ${detail.slice(0, 300)}`);
  }
  console.log(`Published ${descriptor.packId} v${descriptor.version} to the app content catalogue.`);
}

const workRoot = await mkdtemp(path.join(os.tmpdir(), `edju-dlc-${releaseId}-`));
const packRoot = path.join(workRoot, 'pack');
try {
  const [release] = await d1(
    `SELECT id, project_id, version, snapshot_object_key, compiled_module_object_key
       FROM module_releases WHERE id=?`,
    [releaseId]
  );
  if (!release?.compiled_module_object_key) throw new Error('The prepared release could not be found.');
  await d1("UPDATE module_releases SET status='building', error_message=NULL, updated_at=? WHERE id=?", [new Date().toISOString(), releaseId]);

  const [snapshotText, moduleText] = await Promise.all([
    objectText(studiosBucket, release.snapshot_object_key),
    objectText(studiosBucket, release.compiled_module_object_key)
  ]);
  const snapshot = JSON.parse(snapshotText);
  const moduleDefinition = JSON.parse(moduleText);
  const sources = new Map(snapshot.assets.map((asset) => [asset.id, asset]));
  await mkdir(path.join(packRoot, 'module'), { recursive: true });

  const contract = {
    schemaVersion: 1,
    packId: `${moduleDefinition.moduleId}-${moduleDefinition.defaultLanguage}`,
    moduleId: moduleDefinition.moduleId,
    language: moduleDefinition.defaultLanguage,
    version: moduleDefinition.version,
    minimumAppVersion: moduleDefinition.minimumRuntimeVersion,
    displayName: `${moduleDefinition.title || snapshot.release.title} — ${moduleDefinition.defaultLanguage.toUpperCase()}`,
    content: { moduleRoot: 'module', moduleDefinition: 'module/module.json' }
  };
  await writeFile(path.join(packRoot, 'pack.json'), `${JSON.stringify(contract, null, 2)}\n`);
  await writeFile(path.join(packRoot, 'module', 'module.json'), `${JSON.stringify(moduleDefinition, null, 2)}\n`);

  let completed = 0;
  for (const runtimeAsset of moduleDefinition.assets) {
    const source = sources.get(runtimeAsset.id);
    const objectKey = platformFiles[runtimeAsset.id] || source?.objectKey;
    if (!objectKey) throw new Error(`No stored source exists for ${runtimeAsset.id}.`);
    const expectedBytes = source?.byteSize ?? null;
    const head = expectedBytes == null
      ? await s3.send(new GetObjectCommand({ Bucket: studiosBucket, Key: objectKey, Range: 'bytes=0-0' }))
      : null;
    const bytes = expectedBytes ?? Number(head?.ContentRange?.split('/').pop() || 0);
    await downloadVerified(objectKey, safePath(packRoot, runtimeAsset.path), bytes, source?.checksumSha256 || null);
    completed += 1;
    if (completed % 25 === 0 || completed === moduleDefinition.assets.length) {
      console.log(`Downloaded ${completed}/${moduleDefinition.assets.length} files`);
    }
  }

  const payloadPaths = ['pack.json', 'module/module.json', ...moduleDefinition.assets.map((asset) => asset.path)]
    .sort((a, b) => a.localeCompare(b, 'en'));
  const manifestFiles = [];
  let unpackedBytes = 0;
  for (const relativePath of payloadPaths) {
    const absolute = safePath(packRoot, relativePath);
    const fileStat = await stat(absolute);
    const sha256 = await hashFile(absolute, 'sha256');
    manifestFiles.push({ path: relativePath, bytes: fileStat.size, sha256 });
    unpackedBytes += fileStat.size;
  }
  const manifest = {
    schemaVersion: 1, packId: contract.packId, moduleId: contract.moduleId,
    language: contract.language, version: contract.version,
    minimumAppVersion: contract.minimumAppVersion,
    fileCount: manifestFiles.length, unpackedBytes, files: manifestFiles
  };
  await writeFile(path.join(packRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const archiveName = `${contract.packId}-v${contract.version}.zip`;
  const archivePath = path.join(workRoot, archiveName);
  await createZip(packRoot, archivePath, [...payloadPaths, 'manifest.json']);
  const archiveStat = await stat(archivePath);
  const [sha256, md5] = await Promise.all([hashFile(archivePath, 'sha256'), hashFile(archivePath, 'md5')]);
  const packageKey = `modules/${contract.moduleId}/${archiveName}`;
  await s3.send(new PutObjectCommand({
    Bucket: dlcBucket, Key: packageKey, Body: createReadStream(archivePath), ContentLength: archiveStat.size,
    ContentType: 'application/zip', ContentDisposition: `attachment; filename="${archiveName}"`,
    Metadata: { releaseid: releaseId, moduleid: contract.moduleId, version: contract.version, sha256, md5 }
  }));
  await publishCatalogDescriptor({
    archiveBytes: archiveStat.size,
    downloadUrl: `https://dlc.edjucat.com/${packageKey}`,
    fileCount: manifest.fileCount,
    language: contract.language,
    md5,
    minimumAppVersion: contract.minimumAppVersion,
    moduleId: contract.moduleId,
    packId: contract.packId,
    sha256,
    unpackedBytes: manifest.unpackedBytes,
    version: contract.version
  });
  const now = new Date().toISOString();
  await d1(
    `UPDATE module_releases SET status='ready', package_object_key=?, package_byte_size=?,
            package_sha256=?, package_md5=?, error_message=NULL, updated_at=?, completed_at=? WHERE id=?`,
    [packageKey, archiveStat.size, sha256, md5, now, now, releaseId]
  );
  console.log(`DLC ready: ${packageKey}`);
  console.log(`Bytes: ${archiveStat.size}`);
  console.log(`SHA-256: ${sha256}`);
  console.log(`MD5: ${md5}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await setFailed(message);
  throw error;
} finally {
  await rm(workRoot, { recursive: true, force: true });
}
