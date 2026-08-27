const candidate = require('./support/synthetic-candidate-evidence');

candidate.runCli('finalize').then(code => {
  process.exitCode = code;
});
