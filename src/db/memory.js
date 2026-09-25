/**
 * In-memory stand-in for the Sanity Content Lake.
 *
 * Used by the test suite and for local development without Sanity
 * credentials. It speaks the same two operations the store layer uses against
 * Sanity - a GROQ query, and an atomic list of mutations - so every service
 * runs the identical code path against either one:
 *
 *   queries    evaluated by groq-js, Sanity's own reference implementation of
 *              GROQ, so a query that works here works against the Lake
 *   mutations  the subset of Sanity's mutation API the store emits: create,
 *              createIfNotExists, createOrReplace, delete and patch (set,
 *              setIfMissing, unset, inc, append), with ifRevisionID
 *
 * A mutation list is applied all-or-nothing, as a Sanity transaction is: the
 * changes are staged and only written once every mutation has succeeded.
 *
 * With a file path the documents are kept on disk as JSON between runs, so
 * `npm run db:seed` followed by `npm start` behaves like a real database. The
 * write is debounced and flushed on close, because the seed performs
 * thousands of mutations and rewriting the whole file for each would be slow.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse, evaluate } from 'groq-js';

/** The error shape @sanity/client throws, so callers handle both alike. */
export class MutationError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const rev = () => crypto.randomBytes(9).toString('base64url');

/** Apply one patch to a copy of `doc`, in Sanity's documented operation order. */
function applyPatch(doc, patch) {
  const next = clone(doc);

  for (const [k, v] of Object.entries(patch.set ?? {})) next[k] = clone(v);
  for (const [k, v] of Object.entries(patch.setIfMissing ?? {})) {
    if (next[k] === undefined || next[k] === null) next[k] = clone(v);
  }
  for (const k of patch.unset ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      throw new MutationError(`memory store: only top-level unset is supported (${k})`, 400);
    }
    delete next[k];
  }
  for (const [k, v] of Object.entries(patch.inc ?? {})) {
    if (typeof next[k] !== 'number') {
      throw new MutationError(`cannot increment non-numeric field "${k}"`, 409);
    }
    next[k] += v;
  }
  if (patch.insert) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\[-1\]$/.exec(patch.insert.after ?? '');
    if (!m) throw new MutationError('memory store: only insert after field[-1] is supported', 400);
    const list = Array.isArray(next[m[1]]) ? next[m[1]] : [];
    next[m[1]] = [...list, ...clone(patch.insert.items)];
  }
  return next;
}

export class MemoryBackend {
  /** @param {string} [file] a JSON file to persist to, or ':memory:' / nothing */
  constructor(file) {
    this.file = file && file !== ':memory:' ? file : null;
    this.docs = new Map();
    // File assets: id -> { filename, contentType, bytes }. Kept apart from
    // the documents so no GROQ query ever walks over megabytes of PDF.
    this.assets = new Map();
    this.parsed = new Map();
    this.timer = null;

    if (this.file && fs.existsSync(this.file)) {
      const stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // An older file is a bare list of documents; a newer one also carries assets.
      const list = Array.isArray(stored) ? stored : stored.docs ?? [];
      for (const d of list) this.docs.set(d._id, d);
      const assets = Array.isArray(stored) ? {} : stored.assets ?? {};
      for (const [id, a] of Object.entries(assets)) {
        this.assets.set(id, { filename: a.filename, contentType: a.contentType, bytes: Buffer.from(a.data, 'base64') });
      }
    }
  }

  /** Content-addressed, as Sanity's are: the same bytes give the same id. */
  async uploadFile(bytes, { filename, contentType } = {}) {
    const ext = String(filename ?? '').split('.').pop()?.toLowerCase() || 'bin';
    const id = `file-${crypto.createHash('sha1').update(bytes).digest('hex')}-${ext}`;
    this.assets.set(id, { filename, contentType, bytes: Buffer.from(bytes) });
    this.schedulePersist();
    return { assetId: id, url: `memory://${id}`, size: bytes.length };
  }

  async readFile(assetId) {
    return this.assets.get(assetId)?.bytes;
  }

  async deleteFile(assetId) {
    this.assets.delete(assetId);
    this.schedulePersist();
  }

  get name() {
    return this.file ? `local file (${this.file})` : 'in-memory';
  }

  /** Parse once per distinct query: the tests and the seed repeat them a lot. */
  tree(query) {
    let t = this.parsed.get(query);
    if (!t) {
      t = parse(query);
      this.parsed.set(query, t);
    }
    return t;
  }

  async fetch(query, params = {}) {
    const value = await evaluate(this.tree(query), { dataset: this.datasetFor(query, params), params });
    return clone(await value.get());
  }

  /**
   * The documents a query can possibly see.
   *
   * groq-js walks the whole dataset for every `*`, including every `*` nested
   * in a per-row projection, and the code registry dwarfs everything else - so
   * a listing of 25 scans with three joined fields was touching the 4,500
   * codes seventy-five times. When EVERY `*[` in the query opens by pinning
   * the type (`*[_type == "scan"`, `*[_type == $qtype`, `*[_type in $types`),
   * no part of it can match any other type, and evaluating it over just those
   * types gives the identical result. Anything else gets the full dataset.
   */
  datasetFor(query, params) {
    const all = [...this.docs.values()];
    const opens = query.match(/\*\[/g)?.length ?? 0;
    const pinned = [...query.matchAll(/\*\[\s*_type\s*(==|in)\s*("(\w+)"|\$(\w+))/g)];
    if (!opens || pinned.length !== opens) return all;

    const types = new Set();
    for (const m of pinned) {
      const value = m[3] ?? params[m[4]];
      for (const t of [value].flat()) {
        if (typeof t !== 'string') return all;
        types.add(t);
      }
    }
    return all.filter((d) => types.has(d._type));
  }

  async getDocument(id) {
    return clone(this.docs.get(id)) ?? null;
  }

  async getDocuments(ids) {
    return ids.map((id) => clone(this.docs.get(id)) ?? null);
  }

  /** Apply mutations atomically. Returns the resulting document per mutation. */
  async mutate(mutations) {
    const staged = new Map();
    const read = (id) => (staged.has(id) ? staged.get(id) : this.docs.get(id) ?? null);
    const stamp = (doc, prev) => {
      const at = new Date().toISOString();
      return { ...doc, _rev: rev(), _createdAt: prev?._createdAt ?? at, _updatedAt: at };
    };
    const out = [];

    for (const m of mutations) {
      const [op, body] = Object.entries(m)[0];
      switch (op) {
        case 'create': {
          if (read(body._id)) {
            throw new MutationError(`Document by ID "${body._id}" already exists`, 409);
          }
          const doc = stamp(clone(body));
          staged.set(doc._id, doc);
          out.push(doc);
          break;
        }
        case 'createIfNotExists': {
          const existing = read(body._id);
          if (existing) {
            out.push(existing);
            break;
          }
          const doc = stamp(clone(body));
          staged.set(doc._id, doc);
          out.push(doc);
          break;
        }
        case 'createOrReplace': {
          const doc = stamp(clone(body), read(body._id));
          staged.set(doc._id, doc);
          out.push(doc);
          break;
        }
        case 'delete': {
          staged.set(body.id, null);
          out.push(null);
          break;
        }
        case 'patch': {
          const doc = read(body.id);
          if (!doc) throw new MutationError(`Document "${body.id}" not found`, 404);
          if (body.ifRevisionID && body.ifRevisionID !== doc._rev) {
            throw new MutationError(`Document "${body.id}" has unexpected revision`, 409);
          }
          const next = stamp(applyPatch(doc, body), doc);
          staged.set(next._id, next);
          out.push(next);
          break;
        }
        default:
          throw new MutationError(`memory store: unsupported mutation "${op}"`, 400);
      }
    }

    // Every mutation succeeded: publish the staged state in one step.
    for (const [id, doc] of staged) {
      if (doc === null) this.docs.delete(id);
      else this.docs.set(id, doc);
    }
    this.schedulePersist();
    return out.map(clone);
  }

  schedulePersist() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.persist(), 250);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  persist() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Written to a temporary file and renamed, so a crash mid-write cannot
    // leave a truncated database behind.
    const tmp = `${this.file}.tmp`;
    const assets = {};
    for (const [id, a] of this.assets) {
      assets[id] = { filename: a.filename, contentType: a.contentType, data: a.bytes.toString('base64') };
    }
    fs.writeFileSync(tmp, JSON.stringify({ docs: [...this.docs.values()], assets }));
    fs.renameSync(tmp, this.file);
  }

  async close() {
    this.persist();
  }
}

export default MemoryBackend;
