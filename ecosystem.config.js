module.exports = {
  apps: [{
    name: 'meet-recorder',
    script: 'bot.js',
    cwd: __dirname,
    watch: false,
    // Chrome + FFmpeg are children of this process; 500M would restart the bot
    // mid-recording. Give it real headroom.
    max_memory_restart: '1500M',
    env: {
      NODE_ENV: 'production',
    },
    error_file: './logs/error.log',
    out_file: './logs/output.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    restart_delay: 5000,
    max_restarts: 10,
  }],
};
