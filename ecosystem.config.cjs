'use strict';

module.exports = {
  apps: [
    {
      name: 'clash-sub-convert',
      script: './server.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '256M',
      autorestart: true,
      time: true
    }
  ]
};
