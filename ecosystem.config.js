module.exports = {
  apps: [{
    name: 'hefei-points',
    script: './server/index.js',
    cwd: __dirname,
    interpreter: '/usr/bin/node',
    node_args: '--env-file=.env',
    filter_env: ['WX_APPSECRET'],
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    restart_delay: 3000,
    exp_backoff_restart_delay: 100,
    min_uptime: '10s',
    max_restarts: 10,
    max_memory_restart: '300M',
    kill_timeout: 5000,
    listen_timeout: 10000,
    combine_logs: true,
    out_file: './logs/hefei-points-out.log',
    error_file: './logs/hefei-points-error.log',
    time: false,
    env: {
      NODE_ENV: 'production',
      PORT: '3001',
      DATA_DIR: './data',
      LOG_LEVEL: 'info'
    }
  }]
};
