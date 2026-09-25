/**
 * Data store.
 *
 * Every piece of application data lives in Sanity. Two backends sit behind
 * this one interface, chosen by configuration:
 *
 *   Sanity   when SANITY_PROJECT_ID, SANITY_DATASET and SANITY_API_TOKEN are
 *            all set - the production database
 *   memory   otherwise: an in-memory Content Lake stand-in (memory.js) for
 *            tests, persisted to a JSON file for local development, so
 *            neither needs network access or credentials
 *
 * Nothing above this layer talks to a backend directly. Services use the
 * table-shaped helpers below - insert, get, findMany, count, update, tx - and
 * drop to raw GROQ with query() only for joins and aggregates.
 *
 * WHAT THIS LAYER ENFORCES, because Sanity does not:
 *   - required fields, enumerations and defaults (schema.js), on every write
 *   - unique keys, as claim documents created in the same transaction
 *   - integer ids, from a per-type counter document incremented atomically
 *
 * TRANSACTIONS: tx(fn) buffers every write made inside `fn` and commits them
 * as one Sanity transaction when it returns, or discards them if it throws.
 * Reads inside `fn` see committed data only - not the transaction's own
 * pending writes - so insert() returns the row it built rather than reading
 * it back. The buffer is scoped with AsyncLocalStorage, so two requests in
 * flight at once can never write into each other's transaction.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { conflict } from '../lib/errors.js';
import { MemoryBackend } from './memory.js';
import { SanityBackend } from './sanity.js';
import { TYPES, ALL_TYPES, spec, now } from './schema.js';

let handle = null;

/** Is the configured target the hosted Sanity dataset? */
export const usingSanity = () => Boolean(config.sanity.enabled);

/**
 * Open (or reuse) the backend.
 *
 * @param {string} [file] override: ':memory:' for tests, or a JSON file path.
 *   An override always selects the memory backend - a test can never reach
 *   the hosted dataset by accident.
 */
export function open(file) {
  if (handle) return handle;
  if (file === undefined && usingSanity()) {
    handle = new SanityBackend(config.sanity);
  } else {
    handle = new MemoryBackend(file ?? config.db.file);
  }
  return handle;
}

/** The live backend, opening it on first use. */
export function backend() {
  return handle ?? open();
}

/** Human-readable name of the backend in use. Never includes credentials. */
export const describe = () => backend().name;

export async function close() {
  if (!handle) return;
  try {
    await handle.close();
  } finally {
    handle = null;
  }
}

/**
 * Kept for the boot sequence and the build step. There is no DDL to apply to
 * a document store; this proves the backend is reachable, which is the part
 * of "migrate" a deploy actually relied on.
 */
export async function migrate({ silent = false } = {}) {
  await backend().fetch('count(*[_type == "counter"])');
  if (!silent) console.log(`[db] ${describe()} ready`);
  return backend();
}

// ---------------------------------------------------------------------------
// Document ids
// ---------------------------------------------------------------------------

/** A setting key such as 'alerts.duplicate_threshold', made safe for an _id. */
const settingSlug = (key) => String(key).replace(/\./g, '--').replace(/[^A-Za-z0-9_-]/g, '_');

/**
 * The Sanity document id for a row.
 *
 * Deterministic, so a row can be fetched or patched without a query. A code
 * is addressed by the code itself - see schema.js.
 */
export function docIdOf(type, row) {
  if (type === 'code') return `code-${row.code}`;
  if (type === 'setting') return `setting-${settingSlug(row.key ?? row.id)}`;
  return `${type}-${row.id}`;
}

const claimId = (type, fields, row) => {
  const values = fields.map((f) => row[f] ?? null);
  const digest = crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 40);
  return `unique-${type}-${fields.join('_')}-${digest}`;
};

/** The unique-key claim documents a row holds. */
function claimsFor(type, row) {
  const s = spec(type);
  return (s.unique ?? []).map((fields) => ({
    _id: claimId(type, fields, row),
    _type: 'uniqueKey',
    doc_type: type,
    fields,
    owner: docIdOf(type, row),
  }));
}

// ---------------------------------------------------------------------------
// Validation: the NOT NULL / CHECK / DEFAULT rules the SQL schema carried
// ---------------------------------------------------------------------------

function checkField(type, name, def, value) {
  if (value === null || value === undefined) {
    if (def.required) throw new Error(`${type}.${name} is required`);
    return;
  }
  if (def.enum && !def.enum.includes(value)) {
    throw new Error(`${type}.${name} must be one of ${def.enum.join(', ')} (got "${value}")`);
  }
  if ((def.kind === 'int' || def.kind === 'bool01') && !Number.isInteger(value)) {
    throw new Error(`${type}.${name} must be an integer`);
  }
  if (def.kind === 'bool01' && value !== 0 && value !== 1) {
    throw new Error(`${type}.${name} must be 0 or 1`);
  }
  if (def.min !== undefined && value < def.min) {
    throw new Error(`${type}.${name} must be at least ${def.min}`);
  }
  if (def.kind === 'array' && !Array.isArray(value)) {
    throw new Error(`${type}.${name} must be an array`);
  }
}

/** Reject writes to fields the type does not have: a typo must not vanish. */
function assertKnown(type, data) {
  const s = spec(type);
  for (const key of Object.keys(data)) {
    if (key !== 'id' && !s.fields[key]) throw new Error(`${type} has no field "${key}"`);
  }
}

/**
 * Arrays of objects need a stable _key each for the Studio to edit them; the
 * application never sees it (rows strip every underscore field).
 */
function withKeys(def, value) {
  if (def.kind !== 'array' || !Array.isArray(value)) return value;
  return value.map((item) =>
    item && typeof item === 'object' && !item._key
      ? { _key: crypto.randomBytes(6).toString('hex'), ...item }
      : item
  );
}

/** Strip Sanity's own fields; restore every schema field, null when absent. */
function stripKeys(value) {
  if (Array.isArray(value)) return value.map(stripKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!k.startsWith('_')) out[k] = stripKeys(v);
    return out;
  }
  return value;
}

/**
 * Turn a document into the row shape services and the API always used.
 *
 * @param {string[]} [fields] when a query selected particular fields, return
 *   exactly those (plus any computed ones) - so a listing that deliberately
 *   leaves out, say, a pseudonymised IP still leaves it out.
 */
export function toRow(type, doc, fields) {
  if (!doc) return undefined;
  const s = spec(type);
  const out = {};
  if (!fields) {
    out.id = doc.id ?? null;
    for (const name of Object.keys(s.fields)) out[name] = doc[name] ?? null;
  } else {
    for (const name of fields) out[name] = doc[name] ?? null;
  }
  for (const [k, v] of Object.entries(doc)) {
    if (k.startsWith('_') || k in out) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(out)) {
    if (Array.isArray(v) || (v && typeof v === 'object')) out[k] = stripKeys(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const txStore = new AsyncLocalStorage();

/** Inside tx(): buffer. Outside: commit now. */
async function write(mutations) {
  const pending = txStore.getStore();
  if (pending) {
    pending.push(...mutations);
    return null;
  }
  return commit(mutations);
}

/** Send one atomic set of mutations, turning a claim clash into a 409. */
async function commit(mutations) {
  try {
    return await backend().mutate(mutations);
  } catch (err) {
    // A create whose _id is taken: a duplicate code, or a unique-key claim
    // that another row already holds. Either way the caller's row exists.
    if (err?.statusCode === 409 && /already exists/i.test(String(err.message))) {
      throw conflict('That record already exists.');
    }
    throw err;
  }
}

/**
 * Reserve `n` consecutive integer ids for a type.
 *
 * Deliberately outside any transaction, like a SQL sequence: a rolled-back
 * insert leaves a gap, never a reused id.
 */
export async function nextIds(type, n = 1) {
  const id = `counter-${type}`;
  const docs = await backend().mutate([
    { createIfNotExists: { _id: id, _type: 'counter', doc_type: type, value: 0 } },
    { patch: { id, inc: { value: n } } },
  ]);
  const top = docs[1]?.value;
  if (!Number.isInteger(top)) throw new Error(`could not reserve an id for ${type}`);
  return Array.from({ length: n }, (_, i) => top - n + 1 + i);
}

/** Apply defaults and validate a new row. */
function prepareNew(type, data) {
  assertKnown(type, data);
  const s = spec(type);
  const row = {};
  for (const [name, def] of Object.entries(s.fields)) {
    let v = data[name];
    if (v === undefined || v === null) {
      v = typeof def.default === 'function' ? def.default() : def.default;
    }
    checkField(type, name, def, v);
    if (v !== undefined && v !== null) row[name] = v;
  }
  return row;
}

function toDoc(type, row) {
  const s = spec(type);
  const doc = { _id: docIdOf(type, row), _type: type, id: row.id };
  for (const [name, def] of Object.entries(s.fields)) {
    if (row[name] !== undefined && row[name] !== null) doc[name] = withKeys(def, row[name]);
  }
  return doc;
}

/**
 * Insert one row. Returns it as stored (with its id), without a read back -
 * so it works inside a transaction whose writes are not yet visible.
 */
export async function insert(type, data) {
  const s = spec(type);
  const row = prepareNew(type, data);
  if (s.idKind === 'string') {
    row.id = data.id ?? (type === 'setting' ? data.key : null);
    if (!row.id) throw new Error(`${type} needs an id`);
  } else {
    row.id = data.id ?? (await nextIds(type, 1))[0];
  }
  const doc = toDoc(type, row);
  await write([{ create: doc }, ...claimsFor(type, row).map((c) => ({ create: c }))]);
  return toRow(type, doc);
}

/**
 * Insert many rows, in chunks of one transaction each. NOT atomic as a whole
 * - a code issuance can run to hundreds of thousands of documents, far past
 * what one request can carry - so callers must make a retry safe. With
 * `ifNotExists`, a row whose document already exists is left alone, which is
 * what makes re-running an interrupted issuance idempotent.
 */
export async function insertMany(type, rows, { ifNotExists = false, accept, chunk = 250 } = {}) {
  if (txStore.getStore()) throw new Error('insertMany cannot run inside tx()');
  const s = spec(type);
  // Ids only for the rows that arrive without one (an import brings its own).
  const needed = s.idKind === 'string' ? 0 : rows.filter((r) => r.id === undefined || r.id === null).length;
  const fresh = needed ? await nextIds(type, needed) : [];
  let next = 0;
  let n = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const mutations = [];
    for (let j = i; j < Math.min(i + chunk, rows.length); j++) {
      const row = prepareNew(type, rows[j]);
      row.id = rows[j].id ?? (s.idKind === 'string' ? rows[j].key : fresh[next++]);
      const op = ifNotExists ? 'createIfNotExists' : 'create';
      mutations.push({ [op]: toDoc(type, row) });
      for (const c of claimsFor(type, row)) mutations.push({ [op]: c });
    }
    // A document that already exists is only fine if it is this row from an
    // earlier, interrupted run - `accept` says which. Anything else is a
    // genuine duplicate and must fail, as a UNIQUE constraint would have.
    if (ifNotExists && accept) {
      // A query, not getDocuments: 250 ids would overflow a GET url.
      const existing = await backend().fetch('*[_id in $ids]', { ids: mutations.map((m) => m.createIfNotExists._id) });
      const clash = existing.find((d) => d && !accept(d));
      if (clash) throw conflict(`${type} ${clash._id.replace(/^[a-z]+-/i, '')} already exists.`);
    }
    await commit(mutations);
    n += Math.min(chunk, rows.length - i);
  }
  return n;
}

/** Resolve a row reference - an id, or a row carrying its key fields - to a document id. */
async function resolveDocId(type, ref) {
  const row = ref && typeof ref === 'object' ? ref : null;
  if (type === 'code') {
    if (row?.code) return docIdOf('code', row);
    const id = Number(row ? row.id : ref);
    return (await backend().fetch('*[_type == "code" && id == $id][0]._id', { id })) ?? null;
  }
  if (type === 'setting') return docIdOf('setting', { key: row ? row.key ?? row.id : ref });
  const raw = row ? row.id : ref;
  return docIdOf(type, { id: spec(type).idKind === 'string' ? String(raw) : Number(raw) });
}

/**
 * Update one row.
 *
 * `set` values of null clear the field (SQL's SET x = NULL). `inc` adds
 * atomically on the server - the counters on a code are incremented this way
 * so two concurrent scans can never lose one. `setIfMissing` is COALESCE.
 * A type with an updated_at field has it stamped, as every UPDATE did.
 *
 * @param {number|string|object} ref id, or a row. The row must exist.
 */
export async function update(type, ref, set = {}, { inc, setIfMissing, touch = true } = {}) {
  const s = spec(type);
  assertKnown(type, { ...set, ...inc, ...setIfMissing });
  const patchSet = {};
  const unset = [];
  const values = { ...set };
  if (touch && s.fields.updated_at && values.updated_at === undefined) values.updated_at = now();

  for (const [name, v] of Object.entries(values)) {
    if (v === undefined) continue;
    const def = s.fields[name];
    checkField(type, name, def, v);
    if (v === null) unset.push(name);
    else patchSet[name] = withKeys(def, v);
  }
  for (const [name, v] of Object.entries(setIfMissing ?? {})) checkField(type, name, s.fields[name], v);

  const id = await resolveDocId(type, ref);
  if (!id) return false;

  const patch = { id };
  if (Object.keys(patchSet).length) patch.set = patchSet;
  if (unset.length) patch.unset = unset;
  if (inc && Object.keys(inc).length) patch.inc = inc;
  if (setIfMissing && Object.keys(setIfMissing).length) patch.setIfMissing = setIfMissing;
  if (Object.keys(patch).length === 1) return true;

  // The row must exist: a patch to a missing document fails the whole
  // transaction in Sanity. Every caller has already read the row it updates.
  await write([{ patch }]);
  return true;
}

/**
 * UPDATE ... WHERE, for many rows. Pages through the matches by document id
 * and patches each page in one transaction, so it scales to a whole batch of
 * codes. Not atomic as a whole, and never inside tx() - see insertMany.
 * Returns how many rows changed.
 */
export async function updateWhere(type, where, set, { page = 250 } = {}) {
  if (txStore.getStore()) throw new Error('updateWhere cannot run inside tx()');
  const s = spec(type);
  assertKnown(type, set);
  const values = { ...set };
  if (s.fields.updated_at && values.updated_at === undefined) values.updated_at = now();
  for (const [name, v] of Object.entries(values)) checkField(type, name, s.fields[name], v);

  const f = compile(where);
  let after = '';
  let changed = 0;
  for (;;) {
    const ids = await backend().fetch(
      `*[_type == $qtype && _id > $qafter && (${f.groq})] | order(_id asc) [0...${page}]._id`,
      { ...f.params, qtype: type, qafter: after }
    );
    if (!ids.length) break;
    await commit(
      ids.map((id) => {
        const patch = { id };
        const setPart = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null));
        const unset = Object.entries(values).filter(([, v]) => v === null).map(([k]) => k);
        if (Object.keys(setPart).length) patch.set = setPart;
        if (unset.length) patch.unset = unset;
        return { patch };
      })
    );
    changed += ids.length;
    after = ids[ids.length - 1];
    if (ids.length < page) break;
  }
  return changed;
}

/** Delete rows matching `where`, and the unique claims they held. */
export async function removeWhere(type, where) {
  if (txStore.getStore()) throw new Error('removeWhere cannot run inside tx()');
  const f = compile(where);
  let removed = 0;
  for (;;) {
    const docs = await backend().fetch(`*[_type == $qtype && (${f.groq})][0...250]`, { ...f.params, qtype: type });
    if (!docs.length) break;
    const mutations = [];
    for (const d of docs) {
      mutations.push({ delete: { id: d._id } });
      for (const c of claimsFor(type, d)) mutations.push({ delete: { id: c._id } });
    }
    await commit(mutations);
    removed += docs.length;
    if (docs.length < 250) break;
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Compile a where-object to a GROQ filter.
 *
 *   { status: 'open' }                  status == $p0
 *   { status: null }                    status == null   (true when absent)
 *   { status: { in: ['a','b'] } }       status in $p0
 *   { status: { nin: ['a'] } }          !(status in $p0)
 *   { status: { ne: 'x' } }             status != $p0
 *   { created_at: { gte: t, lt: u } }   created_at >= $p0 && created_at < $p1
 *   { code: { match: '*X*' } }          code match $p0
 *   { $or: [whereA, whereB] }
 *   { $raw: 'groq' }                    for the odd filter the shape cannot say
 *
 * Field names come from code, never from a request, so only values are
 * parameterised. They are checked anyway.
 */
export function compile(where = {}, prefix = 'p') {
  const parts = [];
  const params = {};
  let n = 0;
  const param = (v) => {
    const name = `${prefix}${n++}`;
    params[name] = v;
    return `$${name}`;
  };
  const OPS = { eq: '==', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

  for (const [field, cond] of Object.entries(where ?? {})) {
    if (cond === undefined) continue;
    if (field === '$raw') {
      parts.push(`(${cond})`);
      continue;
    }
    if (field === '$or') {
      const alts = cond.map((w, i) => {
        const sub = compile(w, `${prefix}${n++}o${i}_`);
        Object.assign(params, sub.params);
        return `(${sub.groq})`;
      });
      parts.push(`(${alts.join(' || ') || 'false'})`);
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new Error(`bad field name "${field}"`);

    if (cond === null) {
      parts.push(`${field} == null`);
    } else if (typeof cond === 'object' && !Array.isArray(cond)) {
      for (const [op, v] of Object.entries(cond)) {
        if (v === undefined) continue;
        if (op === 'in') parts.push(`${field} in ${param(v)}`);
        else if (op === 'nin') parts.push(`!(${field} in ${param(v)})`);
        else if (op === 'match') parts.push(`${field} match ${param(v)}`);
        else if (op === 'defined') parts.push(v ? `defined(${field})` : `!defined(${field})`);
        else if (op === 'ne' && v === null) parts.push(`${field} != null`);
        else if (OPS[op]) parts.push(`${field} ${OPS[op]} ${param(v)}`);
        else throw new Error(`unknown operator "${op}"`);
      }
    } else {
      parts.push(`${field} == ${param(cond)}`);
    }
  }
  return { groq: parts.length ? parts.join(' && ') : 'true', params };
}

/** `['created_at desc', 'id desc']` -> `| order(created_at desc, id desc)` */
function orderClause(order) {
  if (!order) return '';
  const list = Array.isArray(order) ? order : [order];
  return list.length ? ` | order(${list.join(', ')})` : '';
}

/** A raw GROQ query, for joins and aggregates the helpers cannot express. */
export async function query(groq, params = {}) {
  return backend().fetch(groq, params);
}

/** One row by id. */
export async function get(type, id) {
  if (id === undefined || id === null || id === '') return undefined;
  const s = spec(type);
  if (type === 'code') return findOne('code', { id: Number(id) });
  const key = s.idKind === 'string' ? String(id) : Number(id);
  if (s.idKind !== 'string' && !Number.isInteger(key)) return undefined;
  const doc = await backend().getDocument(docIdOf(type, type === 'setting' ? { key } : { id: key }));
  return doc && doc._type === type ? toRow(type, doc) : undefined;
}

/** One code by the printed code itself - the verification hot path. */
export async function getCode(code) {
  if (!code) return undefined;
  const doc = await backend().getDocument(`code-${code}`);
  return doc && doc._type === 'code' ? toRow('code', doc) : undefined;
}

/**
 * Rows matching `where`.
 *
 * @param {object}   [opts]
 * @param {string|string[]} [opts.order]  e.g. 'created_at desc'
 * @param {number}   [opts.limit]
 * @param {number}   [opts.offset]
 * @param {string[]} [opts.fields]  select only these fields
 * @param {object}   [opts.extra]   computed fields: { name: 'groq expression' },
 *                                  evaluated per row (`^` is not needed; the
 *                                  row's own fields are in scope)
 */
export async function findMany(type, where = {}, { order, limit, offset = 0, fields, extra, params: extraParams } = {}) {
  const f = compile(where);
  const slice = limit !== undefined ? `[${Number(offset)}...${Number(offset) + Number(limit)}]` : '';
  const projection = projectionFor(fields, extra);
  const rows = await backend().fetch(
    `*[_type == $qtype && (${f.groq})]${orderClause(order)}${slice}${projection}`,
    { ...extraParams, ...f.params, qtype: type }
  );
  return rows.map((d) => toRow(type, d, fields));
}

export async function findOne(type, where = {}, opts = {}) {
  const [row] = await findMany(type, where, { ...opts, limit: 1 });
  return row;
}

export async function count(type, where = {}, { params: extraParams } = {}) {
  const f = compile(where);
  return backend().fetch(`count(*[_type == $qtype && (${f.groq})])`, { ...extraParams, ...f.params, qtype: type });
}

function projectionFor(fields, extra) {
  if (!fields && !extra) return '';
  const parts = fields ? ['_id', 'id', ...fields.filter((x) => x !== 'id')] : ['...'];
  for (const [name, expr] of Object.entries(extra ?? {})) parts.push(`"${name}": ${expr}`);
  return ` {${parts.join(', ')}}`;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * Run `fn`, committing every write it makes as one Sanity transaction.
 * Nested calls join the outer transaction.
 */
export async function tx(fn) {
  if (txStore.getStore()) return fn();
  const pending = [];
  const result = await txStore.run(pending, fn);
  if (pending.length) await commit(pending);
  return result;
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/**
 * Delete every document of the given types (all application types by
 * default), including their counters and unique claims.
 *
 * Destructive by definition. Against the hosted dataset it requires an
 * explicit opt-in, because the dataset is the only copy of the code registry
 * and one stray command would orphan every printed pack.
 */
export async function resetAll(types = ALL_TYPES) {
  if (backend() instanceof SanityBackend && process.env.ALLOW_DESTRUCTIVE_RESET !== '1') {
    throw new Error(
      'Refusing to wipe the Sanity dataset. This deletes every product, batch and code. ' +
        'Set ALLOW_DESTRUCTIVE_RESET=1 only if the dataset is a throwaway one.'
    );
  }
  const appTypes = types.filter((t) => TYPES[t]);
  const counterIds = appTypes.map((t) => `counter-${t}`);
  let removed = 0;
  for (;;) {
    const ids = await backend().fetch(
      `*[_type in $types || (_type == "counter" && _id in $counters) || (_type == "uniqueKey" && doc_type in $types)][0...500]._id`,
      { types, counters: counterIds }
    );
    if (!ids.length) break;
    await backend().mutate(ids.map((id) => ({ delete: { id } })));
    removed += ids.length;
  }
  return removed;
}

/** Document counts per type, for the migrate report. */
export async function stats() {
  const out = {};
  for (const t of Object.keys(TYPES)) out[t] = await count(t);
  return out;
}

/**
 * Build a `LIMIT/OFFSET` pair plus page metadata, the pattern every admin
 * list endpoint uses. Keeps pagination consistent across the whole API.
 */
export function paginate({ page = 1, pageSize = 25, maxPageSize = 200 } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || 25, 1), maxPageSize);
  const p = Math.max(Number(page) || 1, 1);
  return { limit: size, offset: (p - 1) * size, page: p, pageSize: size };
}

export { now };

export default {
  open, backend, describe, close, migrate, usingSanity,
  insert, insertMany, update, updateWhere, removeWhere, nextIds,
  get, getCode, findOne, findMany, count, query, compile, toRow, docIdOf,
  tx, resetAll, stats, paginate, now,
};
