const { doBackup } = require('../server/lib/backup');
const { closeDb } = require('../server/db/connection');
const logger = require('../server/lib/logger');

try {
  const result = doBackup();
  if (!result.ok) throw new Error(result.error || '备份失败');
  logger.info({ event: 'backup.command.completed', ...result }, 'backup command completed');
} catch (error) {
  logger.error({ event: 'backup.command.failed', error: error.message }, 'backup command failed');
  process.exitCode = 1;
} finally {
  closeDb();
}
