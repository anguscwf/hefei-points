const {
  acquireBootstrapLock,
  bootstrapSyntheticDatabase,
  createContext,
  decodeCanonicalInput,
  normalizeInput,
  parseArguments,
  readStdin,
  releaseBootstrapLock,
  safeErrorCode,
  validateBootstrapEnvironment
} = require('./support/synthetic-bootstrap');

function usage() {
  return [
    'Usage:',
    '  npm run bootstrap:synthetic-database',
    '',
    'The command accepts no arguments. Connect non-TTY stdin directly to an approved',
    'in-memory secret broker or equivalent non-persistent producer.',
    'Never use an ordinary file, argv, an environment variable, or shell history.',
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
    // Reject an invalid deployment shape and secret channel before accepting
    // credential bytes. Physical paths are validated under the lock below.
    validateBootstrapEnvironment(environment);
    inputBuffer = await readStdin(streams.stdin);
    const document = decodeCanonicalInput(inputBuffer);
    const lock = acquireBootstrapLock(environment);
    try {
      const context = createContext(environment);
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
