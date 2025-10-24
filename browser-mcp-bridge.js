#!/usr/bin/env node

/**
 * Browser MCP Bridge - Server Installer and Runner
 *
 * This script automates the installation and startup of the MCP server.
 * It checks for dependencies, installs them if needed, and starts the server.
 *
 * Usage:
 *   node start-server.js [options]
 *
 * Options:
 *   --port <number>    Custom port (default: 6009)
 *   --dev              Run in development mode with auto-restart
 *   --force-install    Force reinstall dependencies
 *   --help             Show help
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SERVER_DIR = join(__dirname, 'server');
const NODE_MODULES = join(SERVER_DIR, 'node_modules');
const DEFAULT_PORT = 6009;

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  port: DEFAULT_PORT,
  dev: false,
  forceInstall: false,
  help: false
};

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--port':
      options.port = parseInt(args[++i], 10);
      if (isNaN(options.port)) {
        console.error('Error: Invalid port number');
        process.exit(1);
      }
      break;
    case '--dev':
      options.dev = true;
      break;
    case '--force-install':
      options.forceInstall = true;
      break;
    case '--help':
      options.help = true;
      break;
    default:
      console.error(`Unknown option: ${args[i]}`);
      process.exit(1);
  }
}

// Show help
if (options.help) {
  console.log(`
Browser MCP Bridge - Server Installer and Runner

Usage:
  node start-server.js [options]

Options:
  --port <number>    Custom port (default: ${DEFAULT_PORT})
  --dev              Run in development mode with auto-restart
  --force-install    Force reinstall dependencies
  --help             Show this help message

Examples:
  node start-server.js                    # Start with defaults
  node start-server.js --port 8080        # Custom port
  node start-server.js --dev              # Development mode
  node start-server.js --force-install    # Force reinstall
  `);
  process.exit(0);
}

/**
 * Run a command and return a promise
 */
function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`\n▶ Running: ${command} ${args.join(' ')}`);

    const proc = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, ...options.env }
    });

    proc.on('error', (error) => {
      reject(new Error(`Failed to start ${command}: ${error.message}`));
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

/**
 * Check if dependencies are installed
 */
function dependenciesExist() {
  return existsSync(NODE_MODULES);
}

/**
 * Install server dependencies
 */
async function installDependencies() {
  console.log('\n📦 Installing server dependencies...');
  try {
    await runCommand('npm', ['install'], { cwd: SERVER_DIR });
    console.log('✅ Dependencies installed successfully');
    return true;
  } catch (error) {
    console.error('❌ Failed to install dependencies:', error.message);
    return false;
  }
}

/**
 * Start the MCP server
 */
async function startServer() {
  console.log('\n🚀 Starting MCP server...');
  console.log(`   Port: ${options.port}`);
  console.log(`   Mode: ${options.dev ? 'development (auto-restart)' : 'production'}`);
  console.log(`   WebSocket: ws://localhost:${options.port}/ws`);
  console.log(`   HTTP MCP: http://localhost:${options.port}/mcp`);
  console.log(`   Health: http://localhost:${options.port}/health`);
  console.log('\n   Press Ctrl+C to stop the server\n');

  const env = {
    MCP_SERVER_PORT: options.port.toString()
  };

  const serverArgs = options.dev ? ['--watch', 'server.js'] : ['server.js'];

  try {
    await runCommand('node', serverArgs, {
      cwd: SERVER_DIR,
      env
    });
  } catch (error) {
    console.error('❌ Server error:', error.message);
    process.exit(1);
  }
}

/**
 * Main function
 */
async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║   Browser MCP Bridge - Server Manager         ║');
  console.log('╚════════════════════════════════════════════════╝');

  // Check if server directory exists
  if (!existsSync(SERVER_DIR)) {
    console.error(`\n❌ Error: Server directory not found at ${SERVER_DIR}`);
    process.exit(1);
  }

  // Check Node.js version
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  if (majorVersion < 18) {
    console.error(`\n❌ Error: Node.js 18.0.0 or higher required (current: ${nodeVersion})`);
    process.exit(1);
  }
  console.log(`✅ Node.js version: ${nodeVersion}`);

  // Install dependencies if needed
  if (options.forceInstall || !dependenciesExist()) {
    const installed = await installDependencies();
    if (!installed) {
      console.error('\n❌ Cannot proceed without dependencies');
      process.exit(1);
    }
  } else {
    console.log('✅ Dependencies already installed');
  }

  // Start the server
  await startServer();
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down server...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\n👋 Shutting down server...');
  process.exit(0);
});

// Run main function
main().catch((error) => {
  console.error('\n❌ Fatal error:', error.message);
  process.exit(1);
});
