#!/usr/bin/env node
/**
 * Context Bridge MCP Server
 * Bridges the context gap between your codebase and AI coding tools.
 */

// better-sqlite3 is CommonJS. Node's CJS named-export detection does not
// expose a 'Database' named export, and the module's default export IS the
// Database constructor itself.
import Database from 'better-sqlite3';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, join, relative, extname, dirname } from 'path';
import { createServer } from 'http';

const VERSION = '0.1.0';

// --- Database Setup ---
function initDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      content TEXT NOT NULL,
      language TEXT,
      last_modified INTEGER,
      size INTEGER,
      indexed_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY,
      file_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL, -- function, class, variable, import, export
      line_start INTEGER,
      line_end INTEGER,
      signature TEXT,
      docstring TEXT,
      FOREIGN KEY(file_id) REFERENCES files(id)
    );

    CREATE TABLE IF NOT EXISTS relationships (
      id INTEGER PRIMARY KEY,
      from_symbol INTEGER,
      to_symbol INTEGER,
      relation_type TEXT, -- calls, imports, extends, implements
      FOREIGN KEY(from_symbol) REFERENCES symbols(id),
      FOREIGN KEY(to_symbol) REFERENCES symbols(id)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS file_search USING fts5(
      path, content,
      content='files',
      content_rowid='id'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS symbol_search USING fts5(
      name, signature, docstring,
      content='symbols',
      content_rowid='id'
    );
  `);

  return db;
}

// --- File Scanner ---
// Expand a brace group like {js,ts,jsx} into its alternatives.
function expandBraces(pattern) {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];

  let depth = 0;
  let close = -1;
  const parts = [];
  let current = '';
  for (let i = open; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '{') {
      depth++;
      if (depth === 1) continue;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        parts.push(current);
        break;
      }
    } else if (ch === ',' && depth === 1) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (close === -1) return [pattern];

  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const out = [];
  for (const part of parts) {
    for (const expanded of expandBraces(prefix + part + suffix)) {
      out.push(expanded);
    }
  }
  return out;
}

// Backslash, kept in a constant so the regex escaping below stays readable.
const BS = String.fromCharCode(92);

// Translate a single glob pattern (no braces) into an anchored RegExp.
// Supports ** (zero or more path segments), * (within one segment) and ?.
function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('.+^$()|[]'.includes(ch)) {
      re += BS + ch;
    } else if (ch === BS) {
      re += BS + BS;
    } else {
      re += ch;
    }
  }
  return new RegExp('^' + re + '$');
}

// Build matchers for a list of glob patterns.
function buildMatchers(patterns) {
  const expanded = [];
  for (const p of patterns) {
    for (const e of expandBraces(p)) expanded.push(e);
  }
  return expanded.map(globToRegExp);
}

function* walkDir(dir, include, exclude, maxSize = 500 * 1024) {
  const stack = [resolve(dir)];
  const includePatterns = buildMatchers(include);
  const excludePatterns = buildMatchers(exclude);

  while (stack.length) {
    const current = stack.pop();
    try {
      const entries = readdirSync(current);
      for (const entry of entries) {
        const fullPath = join(current, entry);
        const relPath = relative(dir, fullPath);
        const stat = statSync(fullPath);

        if (excludePatterns.some(p => p.test(relPath))) continue;

        if (stat.isDirectory()) {
          stack.push(fullPath);
        } else if (stat.isFile() && stat.size <= maxSize) {
          if (includePatterns.some(p => p.test(relPath))) {
            yield { path: relPath, fullPath, size: stat.size, mtime: stat.mtimeMs };
          }
        }
      }
    } catch (err) {
      // Permission denied or similar, skip
    }
  }
}

// --- Language Detection ---
function detectLanguage(path) {
  const ext = extname(path).toLowerCase();
  const map = {
    '.js': 'javascript', '.ts': 'typescript', '.jsx': 'javascript',
    '.tsx': 'typescript', '.py': 'python', '.rs': 'rust',
    '.go': 'go', '.java': 'java', '.cpp': 'cpp', '.c': 'c',
    '.h': 'c', '.rb': 'ruby', '.php': 'php', '.swift': 'swift',
    '.kt': 'kotlin', '.scala': 'scala', '.sh': 'bash', '.md': 'markdown'
  };
  return map[ext] || 'unknown';
}

// --- Symbol Extractor (Simplified) ---
function extractSymbols(content, language) {
  const symbols = [];
  const lines = content.split('\n');

  // Very basic extraction - real version would use tree-sitter
  const patterns = {
    javascript: [
      /(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)/g,
      /(?:export\s+)?class\s+(\w+)/g,
      /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/g,
      /(?:export\s+)?(?:const|let|var)\s+(\{[^}]*\})\s*=/g,
    ],
    typescript: [
      /(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)/g,
      /(?:export\s+)?(?:interface|type|class)\s+(\w+)/g,
      /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]/g,
    ],
    python: [
      /(?:async\s+)?def\s+(\w+)\s*\(/g,
      /class\s+(\w+)(?:\s*\(|\s*:)/g,
    ],
    rust: [
      /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g,
      /(?:pub\s+)?struct\s+(\w+)/g,
      /(?:pub\s+)?impl(?:\s*<[^>]*>)?\s+(\w+)/g,
    ],
    go: [
      /func\s+(?:\([^)]*\)\s+)?(\w+)/g,
      /type\s+(\w+)\s+(?:struct|interface)/g,
    ],
  };

  const langs = patterns[language] || patterns.javascript;

  for (const pattern of langs) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const line = content.substring(0, match.index).split('\n').length;
      symbols.push({
        name: match[1] || match[0].trim(),
        type: match[0].includes('class') ? 'class' :
              match[0].includes('function') || match[0].includes('fn') || match[0].includes('def') ? 'function' :
              match[0].includes('interface') || match[0].includes('type') ? 'type' : 'variable',
        line_start: line,
        signature: lines[line - 1]?.trim() || '',
      });
    }
  }

  return symbols;
}

// --- Indexer ---
function indexProject(db, config) {
  const root = resolve(config.root || '.');
  const include = config.include || ['**/*.{js,ts,jsx,tsx,py,rs,go,java,rb,php}'];
  const exclude = config.exclude || ['node_modules/**', 'dist/**', 'build/**', '.git/**', '**/*.test.*', '**/*.spec.*'];
  const maxSize = (config.maxFileSizeKB || 500) * 1024;

  console.log(`[Context Bridge] Indexing ${root}...`);
  console.log(`  Include: ${include.join(', ')}`);
  console.log(`  Exclude: ${exclude.join(', ')}`);

  // Re-indexing must not violate the symbols -> files foreign key.
  // 'INSERT OR REPLACE' deletes the old files row, which cascades into a
  // FK violation once that file already has symbols. So: upsert the file
  // row, and clear its old symbols before writing the new ones.
  const upsertFile = db.prepare(`
    INSERT INTO files (path, content, language, last_modified, size)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      content = excluded.content,
      language = excluded.language,
      last_modified = excluded.last_modified,
      size = excluded.size,
      indexed_at = unixepoch()
  `);
  const clearSymbols = db.prepare('DELETE FROM symbols WHERE file_id = ?');
  const insertSymbol = db.prepare(`
    INSERT INTO symbols (file_id, name, type, line_start, signature)
    VALUES (?, ?, ?, ?, ?)
  `);
  const getFileId = db.prepare('SELECT id FROM files WHERE path = ?');

  let fileCount = 0;
  let symbolCount = 0;
  let skippedCount = 0;

  const tx = db.transaction(() => {
    for (const file of walkDir(root, include, exclude, maxSize)) {
      try {
        const content = readFileSync(file.fullPath, 'utf-8');
        const language = detectLanguage(file.path);

        upsertFile.run(file.path, content, language, Math.floor(file.mtime / 1000), file.size);
        fileCount++;

        const row = getFileId.get(file.path);
        if (row) {
          clearSymbols.run(row.id);
          const symbols = extractSymbols(content, language);
          for (const sym of symbols) {
            insertSymbol.run(row.id, sym.name, sym.type, sym.line_start, sym.signature);
            symbolCount++;
          }
        }
      } catch (err) {
        // Binary or unreadable file, skip - but do not hide it silently.
        skippedCount++;
        console.error(`[Context Bridge] Skipped ${file.path}: ${err.message}`);
      }
    }
  });

  tx();

  // Rebuild FTS index
  db.exec(`
    INSERT OR REPLACE INTO file_search(rowid, path, content)
    SELECT id, path, content FROM files;
    INSERT OR REPLACE INTO symbol_search(rowid, name, signature, docstring)
    SELECT id, name, signature, docstring FROM symbols;
  `);

  if (skippedCount > 0) {
    console.log(`[Context Bridge] Skipped ${skippedCount} unreadable file(s).`);
  }
  console.log(`[Context Bridge] Indexed ${fileCount} files, ${symbolCount} symbols.`);
  return { fileCount, symbolCount };
}

// --- MCP Protocol Handlers ---
function handleMCPRequest(db, request) {
  const { tool, params } = request;

  switch (tool) {
    case 'search_code': {
      const { query, limit = 10, language } = params;
      let sql = `
        SELECT f.path, f.language, snippet(file_search, 0, '<mark>', '</mark>', '...', 32) as snippet
        FROM file_search
        JOIN files f ON file_search.rowid = f.id
        WHERE file_search MATCH ?
      `;
      const args = [query];
      if (language) {
        sql += ' AND f.language = ?';
        args.push(language);
      }
      sql += ` LIMIT ?`;
      args.push(limit);

      const results = db.prepare(sql).all(...args);
      return { results };
    }

    case 'get_symbol': {
      const { name, path } = params;
      let sql = `
        SELECT s.*, f.path, f.content
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        WHERE s.name = ?
      `;
      const args = [name];
      if (path) {
        sql += ' AND f.path = ?';
        args.push(path);
      }
      sql += ' LIMIT 10';

      const results = db.prepare(sql).all(...args);
      // Add line content for each result
      for (const r of results) {
        if (r.content) {
          const lines = r.content.split('\n');
          r.context = lines.slice(Math.max(0, r.line_start - 3), r.line_start + 7).join('\n');
          delete r.content; // Don't send full file
        }
      }
      return { results };
    }

    case 'get_dependencies': {
      const { path: filePath } = params;
      const file = db.prepare('SELECT id, content FROM files WHERE path = ?').get(filePath);
      if (!file) return { error: 'File not found' };

      // Simple regex-based import extraction
      const imports = [];
      const importRegex = {
        javascript: /(?:import|require)\s*\(?['"]([^'"]+)['"]\)?/g,
        typescript: /(?:import|require)\s*\(?['"]([^'"]+)['"]\)?/g,
        python: /(?:from|import)\s+([\w.]+)/g,
        rust: /use\s+([\w:]+)/g,
        go: /import\s*\(?\s*['"]([^'"]+)['"]/g,
      };

      const regex = importRegex[file.language] || importRegex.javascript;
      let match;
      while ((match = regex.exec(file.content)) !== null) {
        imports.push(match[1]);
      }

      return { file: filePath, imports: [...new Set(imports)] };
    }

    case 'summarize_module': {
      const { path: modulePath } = params;
      const symbols = db.prepare(`
        SELECT s.name, s.type, COUNT(*) as count
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        WHERE f.path LIKE ? || '%'
        GROUP BY s.type
      `).all(modulePath);

      const files = db.prepare(`
        SELECT path, language FROM files WHERE path LIKE ? || '%'
      `).all(modulePath);

      return {
        module: modulePath,
        files: files.map(f => f.path),
        languages: [...new Set(files.map(f => f.language))],
        symbols: symbols,
        totalFiles: files.length,
      };
    }

    default:
      return { error: `Unknown tool: ${tool}` };
  }
}

// --- Stdio MCP Server ---
function startStdioServer(db) {
  process.stdin.setEncoding('utf8');

  let buffer = '';
  process.stdin.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep incomplete line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const request = JSON.parse(line);
        const result = handleMCPRequest(db, request);
        process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
      } catch (err) {
        process.stdout.write(JSON.stringify({ error: err.message }) + '\n');
      }
    }
  });

  console.log('[Context Bridge] MCP server running on stdio');
}

// --- HTTP Health Check ---
function startHealthCheck(port) {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: VERSION }));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  server.listen(port, () => {
    console.log(`[Context Bridge] Health check on http://localhost:${port}/health`);
  });
  return server;
}

// --- CLI ---
function loadConfig() {
  const configPath = resolve('.context-bridge.json');
  if (existsSync(configPath)) {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  }
  return {};
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'serve';

  if (command === 'init') {
    const config = {
      root: '.',
      include: ['**/*.{js,ts,jsx,tsx,py,rs,go,java,rb,php}'],
      exclude: ['node_modules/**', 'dist/**', 'build/**', '.git/**', '**/*.test.*', '**/*.spec.*'],
      dbPath: '.context-bridge/db.sqlite',
      watch: true,
      maxFileSizeKB: 500,
    };
    const fs = await import('fs/promises');
    await fs.writeFile('.context-bridge.json', JSON.stringify(config, null, 2));
    await fs.mkdir('.context-bridge', { recursive: true });
    console.log('[Context Bridge] Initialized. Edit .context-bridge.json to customize.');
    return;
  }

  const config = loadConfig();
  const dbPath = resolve(config.dbPath || '.context-bridge/db.sqlite');
  const db = initDb(dbPath);

  if (command === 'index') {
    const stats = indexProject(db, config);
    console.log(`Done: ${stats.fileCount} files, ${stats.symbolCount} symbols.`);
    db.close();
    return;
  }

  if (command === 'serve') {
    // Auto-index on startup
    indexProject(db, config);

    // Start MCP server
    startStdioServer(db);

    // Optional HTTP health check
    const healthPort = config.healthPort || 0; // 0 = disabled
    if (healthPort > 0) {
      startHealthCheck(healthPort);
    }

    // Watch for changes
    if (config.watch) {
      const fs = await import('fs');
      const root = resolve(config.root || '.');
      const watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
        if (filename && !filename.includes('node_modules') && !filename.includes('.context-bridge')) {
          console.log(`[Context Bridge] Change detected: ${filename}`);
          // Debounced re-index
          clearTimeout(global._reindexTimer);
          global._reindexTimer = setTimeout(() => indexProject(db, config), 2000);
        }
      });

      process.on('SIGINT', () => {
        watcher.close();
        db.close();
        process.exit(0);
      });
    }
  }

  if (command === 'search') {
    const query = args[1];
    if (!query) {
      console.error('Usage: context-bridge search <query>');
      process.exit(1);
    }
    const results = db.prepare(`
      SELECT f.path, f.language, snippet(file_search, 0, '<mark>', '</mark>', '...', 32) as snippet
      FROM file_search
      JOIN files f ON file_search.rowid = f.id
      WHERE file_search MATCH ?
      LIMIT 10
    `).all(query);

    for (const r of results) {
      console.log(`\n📄 ${r.path} (${r.language})`);
      console.log(`   ${r.snippet?.replace(/<mark>/g, '\x1b[33m').replace(/<\/mark>/g, '\x1b[0m') || '...'}`);
    }
    db.close();
  }
}

main().catch(err => {
  console.error('[Context Bridge] Error:', err);
  process.exit(1);
});
