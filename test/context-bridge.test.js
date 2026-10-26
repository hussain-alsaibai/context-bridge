import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'src', 'server.js');
const INDEXER = join(ROOT, 'src', 'indexer.js');

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'cb-test-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.js'), 'export function hello(name) { return name; }\n');
  writeFileSync(join(dir, 'src', 'util.js'), 'export function slugify(s) { return s.trim(); }\n');
  return dir;
}

function run(args, cwd) {
  return execFileSync('node', [SERVER, ...args], { cwd, encoding: 'utf-8' });
}

function countIndexed(out) {
  const m = out.match(/Indexed (\d+) files, (\d+) symbols/);
  return m ? { files: Number(m[1]), symbols: Number(m[2]) } : null;
}

// Regression: the glob matcher used to translate only '*', so the default
// include pattern '**/*.{js,ts,...}' matched nothing and the indexer always
// reported 0 files.
test('indexes files with the default brace-expanded include pattern', () => {
  const dir = makeProject();
  try {
    run(['init'], dir);
    const counts = countIndexed(run(['index'], dir));
    assert.ok(counts, 'expected an index summary line');
    assert.equal(counts.files, 2, 'expected both source files to be indexed');
    assert.ok(counts.symbols >= 2, 'expected symbols to be extracted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: 'INSERT OR REPLACE' on files deleted the old row, violating the
// symbols -> files foreign key on the second index. The error was swallowed,
// so a re-index silently produced 0 files.
test('re-indexing an existing database does not lose files', () => {
  const dir = makeProject();
  try {
    run(['init'], dir);
    const first = countIndexed(run(['index'], dir));
    const second = countIndexed(run(['index'], dir));
    const third = countIndexed(run(['index'], dir));
    assert.equal(first.files, 2);
    assert.equal(second.files, 2, 'second index must still find the files');
    assert.equal(third.files, 2, 'third index must still find the files');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: better-sqlite3 is CommonJS and exposes no 'Database' named
// export, so 'import { Database } from "better-sqlite3"' threw on startup
// and the package could not run at all.
test('a real MCP client handshake works over stdio (JSON-RPC)', () => {
  // Regression: the server used to read {tool, params}, which is not a shape
  // any MCP client sends. Every real request arrived with tool === undefined
  // and returned 'Unknown tool: undefined', while the old test asserted the
  // same wrong shape and stayed green. This drives the actual JSON-RPC
  // dialect a client uses.
  const dir = makeProject();
  try {
    run(['init'], dir);
    const cfgPath = join(dir, '.context-bridge.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    cfg.watch = false;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'search_code', arguments: { query: 'slugify' } },
      },
    ].map((r) => JSON.stringify(r)).join('\n');

    const out = execFileSync('node', [SERVER, 'serve'], {
      cwd: dir,
      encoding: 'utf-8',
      input: requests + '\n',
    });

    const lines = out.split('\n').filter((l) => l.trim().startsWith('{'));
    const parsed = lines.map((l) => JSON.parse(l));

    const init = parsed.find((m) => m.id === 1);
    assert.ok(init, 'expected an initialize response');
    assert.equal(init.jsonrpc, '2.0');
    assert.ok(init.result.serverInfo, 'initialize must report serverInfo');
    assert.ok(init.result.protocolVersion, 'initialize must report a protocolVersion');

    const list = parsed.find((m) => m.id === 2);
    assert.ok(list, 'expected a tools/list response');
    assert.ok(Array.isArray(list.result.tools), 'tools/list must return an array');
    assert.ok(
      list.result.tools.some((t) => t.name === 'search_code'),
      'tools/list must advertise search_code',
    );

    const call = parsed.find((m) => m.id === 3);
    assert.ok(call, 'expected a tools/call response');
    assert.ok(!call.error, 'tools/call must not error');
    assert.ok(Array.isArray(call.result.results), 'expected search results');
    assert.ok(call.result.results.length > 0, 'expected at least one match');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the server starts and handles an MCP request over stdio', () => {
  const dir = makeProject();
  try {
    run(['init'], dir);
    // Disable the filesystem watcher: a watched process never exits, which
    // would hang execFileSync below.
    const cfgPath = join(dir, '.context-bridge.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    cfg.watch = false;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    const input = JSON.stringify({ id: 1, tool: 'search_code', params: { query: 'slugify' } });
    const out = execFileSync('node', [SERVER, 'serve'], {
      cwd: dir,
      encoding: 'utf-8',
      input: input + '\n',
    });
    const line = out.split('\n').find(l => l.startsWith('{') && l.includes('"id":1'));
    assert.ok(line, 'expected an MCP JSON-RPC response');
    const parsed = JSON.parse(line);
    assert.equal(parsed.id, 1);
    assert.ok(Array.isArray(parsed.result.results), 'expected search results');
    assert.ok(parsed.result.results.length > 0, 'expected at least one match');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The exclude list must keep vendor/build directories out of the index.
test('excluded directories are not indexed', () => {
  const dir = makeProject();
  try {
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'bundle.js'), 'var a = 1;\n');
    writeFileSync(join(dir, 'src', 'app.test.js'), 'export const t = 1;\n');
    run(['init'], dir);
    const counts = countIndexed(run(['index'], dir));
    assert.equal(counts.files, 2, 'node_modules, dist and *.test.js must be excluded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: the standalone indexer (the documented cron-job / pre-commit
// entry point) imported './server.js' for its side effects. That started the
// MCP stdio server instead of indexing anything, so 'npm run index' never
// indexed. It also imported Database, readdirSync, statSync, join, relative
// and extname without using any of them.
test('the standalone indexer indexes a project without starting the server', () => {
  const dir = makeProject();
  try {
    run(['init'], dir);
    rmSync(join(dir, '.context-bridge'), { recursive: true, force: true });

    const out = execFileSync('node', [INDEXER, dir], { encoding: 'utf-8' });
    const counts = countIndexed(out);
    assert.ok(counts, 'expected an index summary line from the standalone indexer');
    assert.equal(counts.files, 2, 'the standalone indexer must index both source files');
    assert.ok(counts.symbols >= 2, 'the standalone indexer must extract symbols');
    assert.ok(!out.includes('MCP'), 'the standalone indexer must not start the MCP server');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: initDb opened the sqlite file without creating its directory.
// 'context-bridge init' created .context-bridge/, but the standalone indexer
// and any cron job on a fresh checkout did not, and it crashed with
// "Cannot open database because the directory does not exist".
test('the indexer creates the database directory when it is missing', () => {
  const dir = makeProject();
  try {
    run(['init'], dir);
    rmSync(join(dir, '.context-bridge'), { recursive: true, force: true });

    const out = execFileSync('node', [INDEXER, dir], { encoding: 'utf-8' });
    assert.ok(countIndexed(out), 'expected the indexer to run without a database directory');
    assert.ok(
      existsSync(join(dir, '.context-bridge', 'db.sqlite')),
      'expected the database file to be created'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
