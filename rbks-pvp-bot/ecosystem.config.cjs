// Configuration PM2 : pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'rbks-pvp-bot',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1, // une seule instance : un bot Discord ne doit jamais tourner en double
      autorestart: true,
      max_memory_restart: '500M',
      kill_timeout: 10000,
      env: { NODE_ENV: 'production' },
    },
  ],
};
