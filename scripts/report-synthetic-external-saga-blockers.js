const readiness = require('./support/synthetic-external-saga-readiness');

readiness.runCli().then(code => {
  process.exitCode = code;
});
