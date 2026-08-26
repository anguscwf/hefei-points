const {
  parseArguments,
  prepareSyntheticDataRoot,
  safeErrorCode
} = require('./support/synthetic-data-root-tools');

function usage() {
  return [
    'Usage:',
    '  node scripts/prepare-synthetic-data-root.js',
    '',
    'The command reads the approved synthetic deployment configuration from the environment.',
    'It only creates a brand-new direct child of SYNTHETIC_DATA_ROOT_APPROVED_PARENT.'
  ].join('\n');
}

function main(argv = process.argv.slice(2), environment = process.env, streams = process) {
  try {
    const options = parseArguments(argv);
    if (options.help) streams.stdout.write(`${usage()}\n`);
    else {
      prepareSyntheticDataRoot(environment);
      streams.stdout.write('SYNTHETIC_DATA_ROOT_PREPARED\n');
    }
    return 0;
  } catch (error) {
    streams.stderr.write(`${safeErrorCode(error, 'PREPARATION_FAILED')}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  main,
  prepareSyntheticDataRoot,
  usage
};
