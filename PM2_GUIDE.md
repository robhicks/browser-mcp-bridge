# PM2 Setup Guide for Browser MCP Bridge

## Quick Start

### 1. Install PM2 (if not already installed)
```bash
npm install -g pm2
```

### 2. Start the server
```bash
# Using npm scripts (recommended)
npm run pm2:start
 OR
pm2 start ecosystem.config.cjs

# Or directly with PM2
pm2 start ecosystem.config.cjs
```

## NPM Scripts

All PM2 commands are available as npm scripts:

```bash
# Start server in production mode
npm run pm2:start

# Start server in development mode (with DEBUG enabled)
npm run pm2:start:dev

# Stop the server
npm run pm2:stop

# Restart the server
npm run pm2:restart

# Remove the server from PM2
npm run pm2:delete

# View logs
npm run pm2:logs

# Check server status
npm run pm2:status

# Save current process list
npm run pm2:save

# Setup auto-start on boot
npm run pm2:startup
```

## Direct PM2 Commands

```bash
# Start with production environment
pm2 start ecosystem.config.cjs

# Start with development environment
pm2 start ecosystem.config.cjs --env development

# View status of all processes
pm2 status

# View logs (live)
pm2 logs browser-mcp-server

# View logs (last 100 lines)
pm2 logs browser-mcp-server --lines 100

# Monitor CPU/Memory
pm2 monit

# Restart server
pm2 restart browser-mcp-server

# Stop server
pm2 stop browser-mcp-server

# Delete from PM2 (stop and remove)
pm2 delete browser-mcp-server

# Show detailed info
pm2 describe browser-mcp-server
```

## Auto-Start on System Boot

```bash
# 1. Setup PM2 startup script (run once)
npm run pm2:startup
# or: pm2 startup

# Follow the instructions displayed (may need sudo)

# 2. Start your server
npm run pm2:start

# 3. Save the process list
npm run pm2:save
# or: pm2 save

# Now the server will automatically start after system reboot!
```

## Custom Port Configuration

To run on a custom port, edit `ecosystem.config.cjs`:

```javascript
env: {
  NODE_ENV: 'production',
  MCP_SERVER_PORT: 8080  // Change this
},
```

Then restart:
```bash
npm run pm2:restart
```

## Logs

PM2 logs are stored in:
- Error logs: `./logs/pm2-error.log`
- Output logs: `./logs/pm2-out.log`
- Combined: `./logs/pm2-combined.log`

View logs in real-time:
```bash
npm run pm2:logs
# or: pm2 logs browser-mcp-server --lines 50
```

## Memory Management

The server will automatically restart if memory usage exceeds 1GB. Configure in `ecosystem.config.cjs`:

```javascript
max_memory_restart: '1G'  // Adjust as needed
```

## Troubleshooting

### Server won't start
```bash
# Check PM2 logs
npm run pm2:logs

# Check if port is in use
lsof -i :6009

# Delete and restart
npm run pm2:delete
npm run pm2:start
```

### Multiple instances running
```bash
# List all PM2 processes
pm2 list

# Delete specific instance
pm2 delete browser-mcp-server

# Delete all
pm2 delete all
```

### Reset everything
```bash
# Stop and delete all processes
pm2 delete all

# Kill PM2 daemon
pm2 kill

# Start fresh
npm run pm2:start
```

## Advanced: Multiple Environments

Run dev and prod simultaneously on different ports:

1. Duplicate the app config in `ecosystem.config.cjs`
2. Change name and port:
```javascript
{
  name: 'browser-mcp-dev',
  script: './server/server.js',
  env: { MCP_SERVER_PORT: 6010 }
}
```

3. Start specific app:
```bash
pm2 start ecosystem.config.cjs --only browser-mcp-dev
```

## Useful PM2 Features

```bash
# Reload (zero-downtime restart)
pm2 reload browser-mcp-server

# Graceful reload
pm2 gracefulReload browser-mcp-server

# Flush logs
pm2 flush browser-mcp-server

# Scale to multiple instances
pm2 scale browser-mcp-server 2

# Update PM2
npm install -g pm2@latest
pm2 update
```
