const {
  parseArguments,
  safeErrorCode,
  verifySyntheticDataRoot
} = require('./support/synthetic-data-root-tools');

function usage() {
  return [
    'Usage:',
    '  node scripts/verify-synthetic-data-root.js',
    '',
    'The command performs two read-only validations of the configured synthetic data root.',
    'Successful stdout is one redacted schema-1 JSON document.'
  ].join('\n');
}

function main(argv = process.argv.slice(2), environment = process.env, streams = process) {
  try {
    const options = parseArguments(argv);
    if (options.help) streams.stdout.write(`${usage()}\n`);
    else {
      const evidence = verifySyntheticDataRoot(environment);
      streams.stdout.write(`${JSON.stringify(evidence)}\n`);
    }
    return 0;
  } catch (error) {
    streams.stderr.write(`${safeErrorCode(error, 'VERIFICATION_FAILED')}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  main,
  usage,
  verifySyntheticDataRoot
};
