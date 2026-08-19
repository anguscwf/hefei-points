const { spawnSync } = require('child_process');
const logger = require('../server/lib/logger');

const executable = process.platform === 'win32' ? 'pm2.cmd' : 'pm2';
const commands = [
  ['install', 'pm2-logrotate'],
  ['set', 'pm2-logrotate:max_size', '10M'],
  ['set', 'pm2-logrotate:retain', '30'],
  ['set', 'pm2-logrotate:compress', 'true'],
  ['set', 'pm2-logrotate:dateFormat', 'YYYY-MM-DD_HH-mm-ss'],
  ['set', 'pm2-logrotate:workerInterval', '30'],
  ['set', 'pm2-logrotate:rotateInterval', '0 0 * * *']
];

for (const args of commands) {
  const result = spawnSync(executable, args, { stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0) {
    logger.error({ event: 'pm2.logrotate.failed', command: args, error: result.error?.message, status: result.status }, 'PM2 log rotation setup failed');
    process.exit(result.status || 1);
  }
}
logger.info({ event: 'pm2.logrotate.configured', maxSize: '10M', retain: 30 }, 'PM2 log rotation configured');
