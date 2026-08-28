const coordination = require('./support/synthetic-authority-coordination-intent');

coordination.runCli().then(code => {
  process.exitCode = code;
});
