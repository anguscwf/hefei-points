const approval = require('./support/synthetic-external-approval');

approval.runCli().then(code => {
  process.exitCode = code;
});
