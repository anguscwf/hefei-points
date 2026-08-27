const {
  acquireBootstrapLock,
  bootstrapSyntheticDatabase,
  createContext,
  decodeCanonicalInput,
  normalizeInput,
  parseArguments,
  readStdin,
  releaseBootstrapLock,
  safeErrorCode
} = require('./support/synthetic-bootstrap');

function usage() {
  return [
    'Usage:',
    '  node scripts/bootstrap-synthetic-database.js < canonical-bootstrap.json',
    '',
    'The command accepts no arguments. It reads one canonical JSON document from non-TTY stdin.',
    'The administrator password is consumed in process memory and is never written to output.'
  ].join('\n');
}

async function main(argv = process.argv.slice(2), environment = process.env, streams = process) {
  let inputBuffer;
  try {
    const options = parseArguments(argv);
    if (options.help) {
      streams.stdout.write(`${usage()}\n`);
      return 0;
    }
    const lock = acquireBootstrapLock(environment);
    try {
      // Validate the complete physical root while the exclusive bootstrap lock
      // is held, before accepting the credential from stdin.
      const context = createContext(environment);
      inputBuffer = await readStdin(streams.stdin);
      const document = decodeCanonicalInput(inputBuffer);
      const now = new Date();
      const input = normalizeInput(document, context, now);
      const result = bootstrapSyntheticDatabase(context, input, { now });
      streams.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    } finally {
      releaseBootstrapLock(lock);
    }
  } catch (error) {
    streams.stderr.write(`${safeErrorCode(error)}\n`);
    return 1;
  } finally {
    if (inputBuffer) inputBuffer.fill(0);
  }
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; });
}

module.exports = { main, usage };
