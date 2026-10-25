#!/usr/bin/env node
/**
 * Standalone indexer for Context Bridge
 * Can be run as a cron job or pre-commit hook
 */

// better-sqlite3 is CommonJS. Node's CJS named-export detection does not
// expose a 'Database' named export, and the module's default export IS the
// Database constructor itself.
import Database from 'better-sqlite3';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, join, relative, extname } from 'path';

// Reuse functions from server.js
// ... (simplified version for standalone use)

const configPath = resolve('.context-bridge.json');
if (!existsSync(configPath)) {
  console.error('[Context Bridge] No .context-bridge.json found. Run: context-bridge init');
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf-8'));
const dbPath = resolve(config.dbPath || '.context-bridge/db.sqlite');

// Import and run indexing from server.js
import('./server.js').then(() => {
  console.log('[Context Bridge] Indexing complete.');
}).catch(err => {
  console.error('[Context Bridge] Index error:', err);
  process.exit(1);
});
