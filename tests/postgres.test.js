/**
 * The SQLite -> Postgres translation layer.
 *
 * These are unit tests on the string rewriting, not on a database. They exist
 * because a mistake here does not fail loudly at the call site: the query is
 * still sent, and Postgres reports something that points nowhere near the
 * cause. The "syntax error at end of input" case below took a production
 * deployment and a log dive to find.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import './setup-env.js';
import { toPositional, translate, insertTarget } from '../src/db/postgres.js';

test('placeholders become positional parameters in order', () => {
  assert.equal(
    toPositional('SELECT * FROM users WHERE email = ? AND status = ?'),
    'SELECT * FROM users WHERE email = $1 AND status = $2'
  );
});

test('a question mark inside a string literal is left alone', () => {
  assert.equal(
    toPositional("SELECT 'is this ok?' AS msg WHERE id = ?"),
    "SELECT 'is this ok?' AS msg WHERE id = $1"
  );
});

test('an escaped quote does not end the literal', () => {
  assert.equal(
    toPositional("SELECT 'it''s fine?' WHERE id = ?"),
    "SELECT 'it''s fine?' WHERE id = $1"
  );
});

/*
 * The regression this file was written for.
 *
 * An apostrophe in a comment is not a quote. Treating it as one left the
 * scanner believing a string was open, so every later placeholder survived as
 * a literal `?` and Postgres rejected the statement.
 */
test('an apostrophe in a line comment does not swallow later placeholders', () => {
  const sql = [
    'SELECT * FROM batches',
    ' WHERE created_at >= ?',
    "   -- the joined product's columns are listed explicitly",
    ' LIMIT ?',
  ].join('\n');

  const out = toPositional(sql);
  assert.ok(out.includes('>= $1'), 'first placeholder');
  assert.ok(out.includes('LIMIT $2'), 'placeholder AFTER the comment');
  assert.equal(out.includes('?'), false, 'no raw placeholder survives');
});

test('an apostrophe in a block comment behaves the same', () => {
  const sql = "SELECT 1 /* don't count this */ WHERE a = ? AND b = ?";
  const out = toPositional(sql);
  assert.ok(out.includes('a = $1') && out.includes('b = $2'));
  assert.equal(out.includes('?'), false);
});

test('comments are preserved rather than stripped', () => {
  const sql = "SELECT 1 -- a note\n WHERE x = ?";
  assert.ok(toPositional(sql).includes('-- a note'));
});

test('strftime becomes an ISO-8601 UTC expression', () => {
  const out = translate("UPDATE b SET at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?");
  assert.ok(out.includes('to_char('), 'uses to_char');
  assert.ok(!out.includes('strftime'), 'no strftime survives');
  assert.ok(out.includes('WHERE id = $1'), 'placeholders still translated around it');
});

test('insertTarget identifies the table an INSERT writes to', () => {
  assert.equal(insertTarget('INSERT INTO users (email) VALUES (?)'), 'users');
  assert.equal(insertTarget('  insert into  "rate_hits" (key) VALUES (?)'), 'rate_hits');
  assert.equal(insertTarget('SELECT * FROM users'), null);
});
