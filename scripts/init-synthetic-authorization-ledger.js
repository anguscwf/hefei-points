const authorization = require('./support/synthetic-authorization-consumer');

authorization.runInitializeCli().then(code => {
  process.exitCode = code;
});
