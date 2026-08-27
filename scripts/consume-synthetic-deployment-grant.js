const authorization = require('./support/synthetic-authorization-consumer');

authorization.runConsumeCli().then(code => {
  process.exitCode = code;
});
