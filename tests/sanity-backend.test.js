/**
 * The Sanity backend's result shape.
 *
 * The Sanity API answers a transaction with one result per DOCUMENT touched,
 * not one per mutation. The store assumed one per mutation - which the memory
 * backend gives - so reserving an id (create the counter if missing, then
 * increment it: two mutations, one document) read a result that did not exist
 * and the very first account created against Sanity failed with "Cannot read
 * properties of undefined (reading 'value')".
 *
 * No network: the client is replaced with one that answers the way the API
 * does.
 */
import './setup-env.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SanityBackend } from '../src/db/sanity.js';

function backendAnswering(documents) {
  const b = new SanityBackend({ projectId: 'test', dataset: 'test', token: 't', apiVersion: '2025-02-19' });
  b.client = { mutate: async () => documents };
  return b;
}

test('two mutations on one document still give one result per mutation', async () => {
  const counter = { _id: 'counter-user', _type: 'counter', value: 1 };
  const b = backendAnswering([counter]);

  const docs = await b.mutate([
    { createIfNotExists: { _id: 'counter-user', _type: 'counter', value: 0 } },
    { patch: { id: 'counter-user', inc: { value: 1 } } },
  ]);

  assert.equal(docs.length, 2);
  assert.equal(docs[1].value, 1, 'the increment is readable where the store looks for it');
});

test('each mutation gets the document it touched, and a delete gets null', async () => {
  const b = backendAnswering([
    { _id: 'user-1', _type: 'user', id: 1 },
    { _id: 'unique-user-email-x', _type: 'uniqueKey' },
  ]);

  const docs = await b.mutate([
    { create: { _id: 'user-1', _type: 'user', id: 1 } },
    { create: { _id: 'unique-user-email-x', _type: 'uniqueKey' } },
    { delete: { id: 'session-old' } },
  ]);

  assert.deepEqual(docs.map((d) => d?._id ?? null), ['user-1', 'unique-user-email-x', null]);
});
