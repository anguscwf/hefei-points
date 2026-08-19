const fs = require('fs');
const path = require('path');
const logger = require('../server/lib/logger');

const root = path.join(__dirname, '..');
const ignoredDirectories = new Set(['.git', '.workbuddy', 'workbuddy', 'archive', 'node_modules', 'backups', 'data', 'data-dev']);
const ignoredRelativeDirectories = new Set(['docs/handoff']);
const ignoredFiles = new Set(['赫菲积分变现路线图v1-20260506.md', '赫菲积分变现路线图v2-20260507.md', 'check-rename.sh', 'check-rename.js']);
const textExtensions = new Set(['.js', '.json', '.html', '.css', '.wxml', '.wxss', '.md', '.sh', '.svg']);

function filesIn(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    const relativePath = path.relative(root, fullPath).split(path.sep).join('/');
    if (entry.isDirectory() && ignoredRelativeDirectories.has(relativePath)) continue;
    if (entry.isFile() && ignoredFiles.has(entry.name)) continue;
    if (entry.isDirectory()) result.push(...filesIn(fullPath));
    else if (entry.isFile() && textExtensions.has(path.extname(entry.name).toLowerCase())) result.push(fullPath);
  }
  return result;
}

const files = filesIn(root);
const forbidden = ['赫菲', '恩霖'];
let failed = false;
for (const word of forbidden) {
  const hits = [];
  for (const filename of files) {
    const lines = fs.readFileSync(filename, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.includes(word)) hits.push(`${path.relative(root, filename)}:${index + 1}`);
    });
  }
  if (hits.length) {
    failed = true;
    logger.error({ event: 'rename_check.failed', word, hits }, 'forbidden legacy name remains');
  } else {
    logger.info({ event: 'rename_check.passed', word }, 'legacy name check passed');
  }
}
process.exitCode = failed ? 1 : 0;
