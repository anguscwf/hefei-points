const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SYNTHETIC_DATA_MARKER_FILENAME = '.tangguan-synthetic-dataset.json';
const SYNTHETIC_DATA_MARKER_PURPOSE = 'tangguan-synthetic-only-v1';
const SQLITE_RELATIVE_PATH = 'data/hefei-points-synthetic.sqlite';
const TOKEN_SECRET_RELATIVE_PATH = 'data/.secret';
const realpathSync = fs.realpathSync.native || fs.realpathSync;

function fail() {
  const error = new Error('synthetic data root physical boundary is unsafe');
  error.code = 'SYNTHETIC_DATA_ROOT_UNSAFE';
  throw error;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isWithin(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

function assertRealPathSegments(target) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  try {
    const rootMetadata = fs.lstatSync(current);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) fail();
    for (const segment of resolved.substring(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const metadata = fs.lstatSync(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail();
    }
  } catch (error) {
    if (error && error.code === 'SYNTHETIC_DATA_ROOT_UNSAFE') throw error;
    fail();
  }
}

function assertRegularSingleLink(filename, required) {
  let metadata;
  try {
    metadata = fs.lstatSync(filename);
  } catch (error) {
    if (!required && error && error.code === 'ENOENT') return null;
    fail();
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) fail();
  let real;
  try {
    real = realpathSync(filename);
  } catch (_) {
    fail();
  }
  if (!samePath(real, filename)) fail();
  return metadata;
}

function markerDocumentFor(validatedDeployment) {
  return Object.freeze({
    schemaVersion: 1,
    purpose: SYNTHETIC_DATA_MARKER_PURPOSE,
    datasetId: validatedDeployment.datasetId,
    apiOriginSha256: sha256(Buffer.from(validatedDeployment.apiOrigin, 'utf8')),
    wechatAppIdSha256: sha256(Buffer.from(validatedDeployment.wechatAppId, 'utf8')),
    sqliteRelativePath: SQLITE_RELATIVE_PATH,
    tokenSecretRelativePath: TOKEN_SECRET_RELATIVE_PATH
  });
}

function markerBufferFor(validatedDeployment) {
  return Buffer.from(`${JSON.stringify(markerDocumentFor(validatedDeployment), null, 2)}\n`, 'utf8');
}

function validateSyntheticRuntimeFilesystem(validatedDeployment, projectRoot) {
  if (!validatedDeployment || validatedDeployment.deploymentTier !== 'synthetic'
      || !validatedDeployment.dataPaths || typeof projectRoot !== 'string') {
    fail();
  }
  const { root, dataDir, sqliteFile } = validatedDeployment.dataPaths;
  assertRealPathSegments(root);
  assertRealPathSegments(dataDir);

  let projectRealRoot;
  let rootReal;
  let dataReal;
  try {
    projectRealRoot = realpathSync(projectRoot);
    rootReal = realpathSync(root);
    dataReal = realpathSync(dataDir);
  } catch (_) {
    fail();
  }
  if (isWithin(projectRealRoot, rootReal) || isWithin(rootReal, projectRealRoot)
      || !samePath(dataReal, path.join(rootReal, 'data'))
      || !samePath(sqliteFile, path.join(dataDir, 'hefei-points-synthetic.sqlite'))) {
    fail();
  }

  const markerFile = path.join(root, SYNTHETIC_DATA_MARKER_FILENAME);
  const markerMetadata = assertRegularSingleLink(markerFile, true);
  if (!markerMetadata || markerMetadata.size < 2 || markerMetadata.size > 4096) fail();
  let marker;
  try {
    marker = fs.readFileSync(markerFile);
  } catch (_) {
    fail();
  }
  if (!marker.equals(markerBufferFor(validatedDeployment))) fail();

  let rootEntries;
  let dataEntries;
  try {
    rootEntries = fs.readdirSync(root, { withFileTypes: true });
    dataEntries = fs.readdirSync(dataDir, { withFileTypes: true });
  } catch (_) {
    fail();
  }
  const markerEntry = rootEntries.find(entry => entry.name === SYNTHETIC_DATA_MARKER_FILENAME);
  const dataEntry = rootEntries.find(entry => entry.name === 'data');
  if (rootEntries.length !== 2 || !markerEntry || !dataEntry
      || !markerEntry.isFile() || markerEntry.isSymbolicLink()
      || !dataEntry.isDirectory() || dataEntry.isSymbolicLink()) {
    fail();
  }
  const allowedDataFiles = new Set([
    '.secret',
    'hefei-points-synthetic.sqlite',
    'hefei-points-synthetic.sqlite-shm',
    'hefei-points-synthetic.sqlite-wal'
  ]);
  if (dataEntries.some(entry => !allowedDataFiles.has(entry.name)
      || !entry.isFile() || entry.isSymbolicLink())) {
    fail();
  }

  for (const filename of [
    sqliteFile,
    `${sqliteFile}-wal`,
    `${sqliteFile}-shm`,
    path.join(dataDir, '.secret')
  ]) {
    assertRegularSingleLink(filename, false);
  }
  return Object.freeze({
    markerSha256: sha256(marker),
    sqliteRelativePath: SQLITE_RELATIVE_PATH
  });
}

module.exports = {
  SQLITE_RELATIVE_PATH,
  TOKEN_SECRET_RELATIVE_PATH,
  SYNTHETIC_DATA_MARKER_FILENAME,
  SYNTHETIC_DATA_MARKER_PURPOSE,
  markerBufferFor,
  markerDocumentFor,
  validateSyntheticRuntimeFilesystem
};
