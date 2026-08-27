const candidate = require('./support/synthetic-candidate-evidence');

candidate.runCli('capture').then(code => {
  process.exitCode = code;
});
