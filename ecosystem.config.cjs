/**
 * PM2 Ecosystem Configuration for Browser MCP Bridge
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 start ecosystem.config.cjs --env production
 *   pm2 start ecosystem.config.cjs --only browser-mcp-server
 *
 * Management:
 *   pm2 status
 *   pm2 logs browser-mcp-server
 *   pm2 restart browser-mcp-server
 *   pm2 stop browser-mcp-server
 *   pm2 delete browser-mcp-server
 *   pm2 save                     # Save current process list
 *   pm2 startup                  # Enable auto-start on boot
 */

module.exports = {
  apps: [
    {
      name: 'browser-mcp-server',
      script: './server/server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',

      // Environment variables
      env: {
        NODE_ENV: 'production',
        MCP_SERVER_PORT: 6009
      },

      // Production environment (use with --env production)
      env_production: {
        NODE_ENV: 'production',
        MCP_SERVER_PORT: 6009
      },

      // Development environment (use with --env development)
      env_development: {
        NODE_ENV: 'development',
        MCP_SERVER_PORT: 6009,
        DEBUG: '*'
      },

      // Logging
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_file: './logs/pm2-combined.log',
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // Advanced options
      merge_logs: true,
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 4000,

      // Process management
      kill_timeout: 5000,
      wait_ready: false,
      listen_timeout: 10000
    }
  ]
};
