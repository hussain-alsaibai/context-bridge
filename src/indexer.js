#!/usr/bin/env node
/**
 * Standalone indexer for Context Bridge.
 * Can be run as a cron job or pre-commit hook.
 *
 * History: this file used to import './server.js' for its side effects, which
 * started the MCP stdio server instead of indexing anything — so
 * 'npm run index' never indexed and could hang. It also carried a copy of the
 * imports (Database, readdirSync, statSync, join, relative, extname) that it
 * never used. Now it reuses the real implementation from server.js.
 *
 * Usage:
 *   node src/indexer.js [projectRoot]
 *
 * Reads <projectRoot>/.context-bridge.json. The database path and the include
 * and exclude patterns are taken from that file; the root is the directory
 * given on the command line (default: the current directory).
 */

import { resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
import { initDb, indexProject } from './server.js';

const root = resolve(process.argv[2] || '.');
const configPath = resolve(root, '.context-bridge.json');

if (!existsSync(configPath)) {
  console.error(
    '[Context Bridge] No .context-bridge.json found in ' + root +
    '. Run: context-bridge init'
  );
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf-8'));
const dbPath = resolve(root, config.dbPath || '.context-bridge/db.sqlite');
const db = initDb(dbPath);

try {
  const stats = indexProject(db, { ...config, root });
  console.log(`Done: ${stats.fileCount} files, ${stats.symbolCount} symbols.`);
} finally {
  db.close();
}
