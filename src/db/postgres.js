/**
 * PostgreSQL backend - the production database (Coolify, Bishnoi One).
 *
 * WHAT IS STORED WHERE
 *
 *   <schema>.documents   one row per document: the same documents the app
 *                        has always written (products, batches, codes, scans,
 *                        users, alerts...), as JSONB, with the id, type and
 *                        revision pulled out into columns
 *   <schema>.files       every stored file, the bytes in a BYTEA column:
 *                        leaflet PDFs, uploaded Excel/CSV imports, Excel
 *                        exports, generated QR images, avatars and product
 *                        images - each tagged with its `kind`
 *
 * Everything lives in its own schema (DATABASE_SCHEMA, default "qrshield"),
 * so the app can share a Postgres server - even a database - with another
 * application without either touching the other's tables.
 *
 * HOW QUERIES RUN
 *
 * The services speak GROQ (see src/db/index.js), not SQL. This backend keeps
 * a write-through copy of every document in memory and evaluates GROQ over it
 * with groq-js - the same engine and the same code path as the memory backend
 * the tests use - while Postgres is the durable, transactional store:
 *
 *   boot     every document is loaded from Postgres into memory
 *   read     answered from memory: no round trip, so verification stays fast
 *   write    one Postgres transaction per mutation list. The rows it touches
 *            are locked (SELECT ... FOR UPDATE), the change is staged against
 *            their committed state, written, and COMMITTED - and only then
 *            made visible in memory. A failed write changes nothing anywhere.
 *
 * Writes are serialised inside the process, so two concurrent scans of one
 * code can never lose a counter increment.
 *
 * MORE THAN ONE INSTANCE
 *
 * Run ONE replica. A second instance (a rolling deploy overlapping the old
 * container, say) stays correct for writes - every write re-reads the locked
 * rows' committed state before staging, and a create that races another
 * instance's fails on the primary key and is retried - and each commit sends
 * a NOTIFY so other instances reload the documents it changed. That keeps
 * an overlap safe; it is not a design for scaling out.
 *
 * Never logs the connection string or the password.
 */
import crypto from 'node:crypto';
import pg from 'pg';
import { MemoryBackend, MutationError } from './memory.js';

const CHANNEL = 'qrshield_documents';
/** NOTIFY payloads must stay under 8000 bytes; past this, ask for a full reload. */
const MAX_NOTIFY_BYTES = 7000;
/** Rows per round trip when loading or writing in bulk. */
const LOAD_PAGE = 5000;

/** Postgres's unique_violation. */
const UNIQUE_VIOLATION = '23505';

/** Only a plain identifier is accepted as a schema name: it is interpolated into SQL. */
export function assertSchemaName(name) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(String(name))) {
    throw new Error(`DATABASE_SCHEMA must be a plain lower-case identifier (got "${name}")`);
  }
  return name;
}

/** The kinds of file the app stores. The CHECK constraint below lists the same. */
export const FILE_KINDS = ['leaflet', 'import', 'export', 'qr', 'avatar', 'product_image'];

/** The DDL. Idempotent: run on every boot. */
export function schemaSql(schema) {
  const s = assertSchemaName(schema);
  return `
CREATE SCHEMA IF NOT EXISTS ${s};

CREATE TABLE IF NOT EXISTS ${s}.documents (
  id          text        PRIMARY KEY,
  type        text        NOT NULL,
  rev         text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  doc         jsonb       NOT NULL
);
CREATE INDEX IF NOT EXISTS documents_type_idx ON ${s}.documents (type);

CREATE TABLE IF NOT EXISTS ${s}.files (
  id            text        PRIMARY KEY,
  kind          text        NOT NULL
                CHECK (kind IN (${FILE_KINDS.map((k) => `'${k}'`).join(', ')})),
  filename      text,
  content_type  text        NOT NULL,
  size          integer     NOT NULL CHECK (size >= 0),
  sha256        text        NOT NULL,
  bytes         bytea       NOT NULL,
  meta          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_by    integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (size = octet_length(bytes))
);
CREATE INDEX IF NOT EXISTS files_kind_created_idx ON ${s}.files (kind, created_at DESC);
`;
}

/** SSL options from DATABASE_SSL: disable | require | verify. */
function sslOption(mode) {
  switch (String(mode || 'disable').toLowerCase()) {
    case 'disable':
    case 'false':
    case 'off':
      return false;
    case 'require':
      // Encrypted, but the certificate is not checked: what a self-signed
      // Coolify certificate needs.
      return { rejectUnauthorized: false };
    case 'verify':
    case 'verify-full':
      return { rejectUnauthorized: true };
    default:
      throw new Error(`DATABASE_SSL must be disable, require or verify (got "${mode}")`);
  }
}

/** host:port/database, for logs. Never the user or password. */
export function describeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname || ''}`;
  } catch {
    return 'configured database';
  }
}

/** A queue of one: runs each task only after the previous has settled. */
class Serial {
  constructor() {
    this.tail = Promise.resolve();
  }
  run(task) {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

const touchedIds = (mutations) => [
  ...new Set(
    mutations.map((m) => {
      const [op, body] = Object.entries(m)[0];
      return op === 'patch' || op === 'delete' ? body.id : body._id;
    })
  ),
];

export class PostgresBackend extends MemoryBackend {
  /**
   * @param {object} opts
   * @param {string} opts.url       postgres:// connection string
   * @param {string} [opts.schema]  schema the tables live in
   * @param {string} [opts.ssl]     disable | require | verify
   * @param {number} [opts.poolMax]
   * @param {boolean} [opts.listen] reload on other instances' writes (default true)
   */
  constructor({ url, schema = 'qrshield', ssl = 'disable', poolMax = 10, listen = true } = {}) {
    super(); // no file: the memory map is a cache here, never persisted
    if (!url) throw new Error('PostgresBackend needs a connection string');
    this.url = url;
    this.schema = assertSchemaName(schema);
    this.t = `${this.schema}.documents`;
    this.f = `${this.schema}.files`;
    this.instance = crypto.randomBytes(8).toString('hex');
    this.serial = new Serial();
    this.listenEnabled = listen;
    this.closed = false;
    this.pool = new pg.Pool({
      connectionString: url,
      ssl: sslOption(ssl),
      max: poolMax,
      // A dropped connection must fail a request, not hang it.
      connectionTimeoutMillis: 15_000,
      idleTimeoutMillis: 30_000,
      application_name: 'qrshield',
    });
    // An idle client dying (the database restarting) must not crash the process.
    this.pool.on('error', (err) => console.error(`[db] idle Postgres connection lost: ${err.message}`));
    this.ready = this.init();
    // The first caller sees the failure; this keeps an unobserved one from
    // crashing the process before anyone has asked.
    this.ready.catch(() => {});
  }

  get name() {
    return `PostgreSQL (${describeUrl(this.url)}, schema "${this.schema}")`;
  }

  async init() {
    await this.pool.query(schemaSql(this.schema));
    await this.loadAll();
    if (this.listenEnabled) await this.startListening();
  }

  /** Replace the in-memory copy with every committed document. */
  async loadAll() {
    const fresh = new Map();
    let after = '';
    for (;;) {
      const { rows } = await this.pool.query(
        `SELECT id, doc FROM ${this.t} WHERE id > $1 ORDER BY id LIMIT ${LOAD_PAGE}`,
        [after]
      );
      for (const r of rows) fresh.set(r.id, r.doc);
      if (rows.length < LOAD_PAGE) break;
      after = rows[rows.length - 1].id;
    }
    this.docs = fresh;
  }

  /** Reload some documents from Postgres: another instance changed them. */
  async reload(ids) {
    const { rows } = await this.pool.query(`SELECT id, doc FROM ${this.t} WHERE id = ANY($1)`, [ids]);
    const found = new Map(rows.map((r) => [r.id, r.doc]));
    for (const id of ids) {
      if (found.has(id)) this.docs.set(id, found.get(id));
      else this.docs.delete(id);
    }
  }

  async startListening() {
    if (this.closed) return;
    const client = new pg.Client({ connectionString: this.url, ssl: this.pool.options.ssl });
    client.on('error', (err) => {
      console.error(`[db] Postgres listener lost (${err.message}); reconnecting`);
      this.restartListening();
    });
    client.on('notification', (msg) => {
      if (msg.channel !== CHANNEL) return;
      let note;
      try {
        note = JSON.parse(msg.payload);
      } catch {
        return;
      }
      if (note.src === this.instance) return;
      // Through the write queue, so a reload never interleaves with a write.
      this.serial
        .run(() => (note.all ? this.loadAll() : this.reload(note.ids ?? [])))
        .catch((err) => console.error(`[db] could not reload changed documents: ${err.message}`));
    });
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    this.listener = client;
  }

  restartListening() {
    const old = this.listener;
    this.listener = null;
    old?.end().catch(() => {});
    if (this.closed || this.relistenTimer) return;
    this.relistenTimer = setTimeout(async () => {
      this.relistenTimer = null;
      try {
        // Anything could have changed while nobody was listening.
        await this.serial.run(() => this.loadAll());
        await this.startListening();
      } catch (err) {
        console.error(`[db] Postgres listener: ${err.message}; retrying`);
        this.restartListening();
      }
    }, 2000);
    this.relistenTimer.unref?.();
  }

  // -------------------------------------------------------------------------
  // Reads: from the in-memory copy, once it is loaded
  // -------------------------------------------------------------------------

  async fetch(query, params) {
    await this.ready;
    return super.fetch(query, params);
  }

  async getDocument(id) {
    await this.ready;
    return super.getDocument(id);
  }

  async getDocuments(ids) {
    await this.ready;
    return super.getDocuments(ids);
  }

  // -------------------------------------------------------------------------
  // Writes: Postgres first, memory only after COMMIT
  // -------------------------------------------------------------------------

  async mutate(mutations) {
    await this.ready;
    if (!mutations.length) return [];
    return this.serial.run(async () => {
      // A create racing another instance's create fails on the primary key;
      // the retry re-reads, sees the row, and answers as a create would.
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.mutateOnce(mutations);
        } catch (err) {
          if (err?.code === UNIQUE_VIOLATION && attempt < 2) continue;
          if (err?.code === UNIQUE_VIOLATION) {
            throw new MutationError(`Document already exists (${err.detail ?? 'unique key'})`, 409);
          }
          throw err;
        }
      }
    });
  }

  async mutateOnce(mutations) {
    const ids = touchedIds(mutations);
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;

      // Lock what exists, and bring the copy in memory up to its committed state.
      const { rows } = await client.query(`SELECT id, rev, doc FROM ${this.t} WHERE id = ANY($1) FOR UPDATE`, [ids]);
      const committed = new Map(rows.map((r) => [r.id, r]));
      for (const id of ids) {
        const row = committed.get(id);
        const mem = this.docs.get(id);
        if (!row && mem) this.docs.delete(id);
        else if (row && mem?._rev !== row.rev) this.docs.set(id, row.doc);
      }

      // Throws MutationError (404, 409...) with nothing written.
      const { staged, out } = this.stage(mutations);

      const inserts = [];
      const updates = [];
      const deletes = [];
      for (const [id, doc] of staged) {
        if (doc === null) {
          if (committed.has(id)) deletes.push(id);
        } else if (committed.has(id)) updates.push(doc);
        else inserts.push(doc);
      }

      if (deletes.length) await client.query(`DELETE FROM ${this.t} WHERE id = ANY($1)`, [deletes]);
      if (inserts.length) {
        await client.query(
          `INSERT INTO ${this.t} (id, type, rev, created_at, updated_at, doc)
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[], $5::timestamptz[], $6::jsonb[])`,
          columns(inserts)
        );
      }
      if (updates.length) {
        await client.query(
          `UPDATE ${this.t} AS d
              SET type = u.type, rev = u.rev, updated_at = u.updated_at, doc = u.doc
             FROM unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[], $5::timestamptz[], $6::jsonb[])
                  AS u(id, type, rev, created_at, updated_at, doc)
            WHERE d.id = u.id`,
          columns(updates)
        );
      }

      const changed = [...staged.keys()];
      let payload = JSON.stringify({ src: this.instance, ids: changed });
      if (Buffer.byteLength(payload) > MAX_NOTIFY_BYTES) payload = JSON.stringify({ src: this.instance, all: true });
      await client.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]);

      await client.query('COMMIT');
      began = false;

      this.publish(staged);
      return out.map((d) => (d === null ? null : structuredClone(d)));
    } catch (err) {
      if (began) await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Files: bytes in Postgres, never in the memory copy
  // -------------------------------------------------------------------------

  async uploadFile(bytes, { filename, contentType, kind = 'leaflet', id, meta, createdBy } = {}) {
    await this.ready;
    const buf = Buffer.from(bytes);
    const ext = String(filename ?? '').split('.').pop()?.toLowerCase() || 'bin';
    const assetId = id ?? `file-${crypto.createHash('sha1').update(buf).digest('hex')}-${ext}`;
    // Content-addressed ids make a repeat upload of the same bytes a no-op.
    await this.pool.query(
      `INSERT INTO ${this.f} (id, kind, filename, content_type, size, sha256, bytes, meta, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [
        assetId,
        kind,
        filename ?? null,
        contentType ?? 'application/octet-stream',
        buf.length,
        crypto.createHash('sha256').update(buf).digest('hex'),
        buf,
        JSON.stringify(meta ?? {}),
        createdBy ?? null,
      ]
    );
    return { assetId, url: `postgres://files/${assetId}`, size: buf.length };
  }

  async readFile(assetId) {
    await this.ready;
    const { rows } = await this.pool.query(`SELECT bytes FROM ${this.f} WHERE id = $1`, [assetId]);
    return rows[0]?.bytes;
  }

  async deleteFile(assetId) {
    await this.ready;
    await this.pool.query(`DELETE FROM ${this.f} WHERE id = $1`, [assetId]);
  }

  async fileInfo(assetId) {
    await this.ready;
    const { rows } = await this.pool.query(`SELECT ${FILE_COLUMNS} FROM ${this.f} WHERE id = $1`, [assetId]);
    return rows[0] ? fileRow(rows[0]) : undefined;
  }

  async listFiles({ kind, limit = 50, offset = 0 } = {}) {
    await this.ready;
    const where = kind ? 'WHERE kind = $1' : '';
    const params = kind ? [kind] : [];
    const [{ rows }, total] = await Promise.all([
      this.pool.query(
        `SELECT ${FILE_COLUMNS} FROM ${this.f} ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT ${Number(limit) | 0} OFFSET ${Number(offset) | 0}`,
        params
      ),
      this.pool.query(`SELECT count(*)::int AS n FROM ${this.f} ${where}`, params),
    ]);
    return { total: total.rows[0].n, items: rows.map(fileRow) };
  }

  /** Bytes stored per kind - for the migrate report. */
  async fileStats() {
    await this.ready;
    const { rows } = await this.pool.query(
      `SELECT kind, count(*)::int AS n, coalesce(sum(size), 0)::bigint AS bytes FROM ${this.f} GROUP BY kind ORDER BY kind`
    );
    return rows.map((r) => ({ kind: r.kind, files: r.n, bytes: Number(r.bytes) }));
  }

  /** Never persisted to a file: Postgres is the store. */
  schedulePersist() {}
  persist() {}

  async close() {
    this.closed = true;
    clearTimeout(this.relistenTimer);
    await this.ready.catch(() => {});
    await this.serial.run(() => {}); // let an in-flight write finish
    await this.listener?.end().catch(() => {});
    await this.pool.end();
  }
}

const FILE_COLUMNS = 'id, kind, filename, content_type, size, sha256, meta, created_by, created_at';

const fileRow = (r) => ({
  id: r.id,
  kind: r.kind,
  filename: r.filename,
  contentType: r.content_type,
  size: r.size,
  sha256: r.sha256,
  meta: r.meta ?? {},
  createdBy: r.created_by,
  createdAt: new Date(r.created_at).toISOString(),
});

/** Documents as the six parallel arrays the unnest() writes take. */
function columns(docs) {
  return [
    docs.map((d) => d._id),
    docs.map((d) => d._type),
    docs.map((d) => d._rev),
    docs.map((d) => d._createdAt ?? new Date().toISOString()),
    docs.map((d) => d._updatedAt ?? new Date().toISOString()),
    docs.map((d) => JSON.stringify(d)),
  ];
}

export default PostgresBackend;
