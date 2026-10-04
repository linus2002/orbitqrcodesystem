/**
 * What Vercel ships with the API.
 *
 * A serverless function on Vercel carries only the files its tracer
 * (@vercel/nft) can see the code load: import statements, and calls to a
 * function NAMED `require` with a literal path. The city list was once loaded
 * as `createRequire(import.meta.url)('../data/ph-places.json')` - a call with
 * no name - so the tracer left the file out, and every API request on the
 * live site failed with FUNCTION_INVOCATION_FAILED ("Cannot find module
 * '../data/ph-places.json'"). Everything worked locally, where every file is
 * on disk; only the shipped function was missing it.
 *
 * These checks hold the server code to the forms the tracer follows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every .js file under a directory of the repository, as repo-relative paths. */
function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

// What the function is built from: the entry point and the server code.
const SERVER_FILES = [...jsFiles('api'), ...jsFiles('src')];
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** A file's code without its comments, which may quote the forms warned against. */
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('a createRequire() result is always bound to the name `require`', () => {
  for (const rel of SERVER_FILES) {
    const src = code(rel);
    assert.doesNotMatch(
      src,
      /createRequire\([^)]*\)\s*\(/,
      `${rel} calls createRequire(...)(...) directly - Vercel will not ship what it loads`
    );
    for (const [, name] of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*createRequire\(/g)) {
      assert.equal(name, 'require', `${rel} names its createRequire() result "${name}" - Vercel only follows "require"`);
    }
  }
});

test('require() is only given literal paths, and each one exists', () => {
  for (const rel of SERVER_FILES) {
    const src = code(rel);
    if (!/createRequire\(/.test(src)) continue;
    for (const [, arg] of src.matchAll(/\brequire\(([^)]*)\)/g)) {
      const literal = /^\s*(['"])([^'"]+)\1\s*$/.exec(arg);
      assert.ok(literal, `${rel}: require(${arg.trim()}) is not a literal path - Vercel will not ship it`);
      const target = literal[2];
      if (target.startsWith('.')) {
        const file = path.resolve(path.dirname(path.join(ROOT, rel)), target);
        assert.ok(fs.existsSync(file), `${rel}: require('${target}') points at a file that does not exist`);
      }
    }
  }
});

test('the city list is loaded in the form the tracer follows', () => {
  assert.match(read(path.join('src', 'services', 'places.js')), /\brequire\('\.\.\/data\/ph-places\.json'\)/);
});
