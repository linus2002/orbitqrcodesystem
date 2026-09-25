/**
 * Sanity Content Lake backend - the production database.
 *
 * Server-side only. The project id, dataset and token come from server
 * environment variables (SANITY_PROJECT_ID, SANITY_DATASET, SANITY_API_TOKEN)
 * and never reach the browser: the React client only ever talks to this
 * application's own /api, and Vite exposes nothing that is not prefixed
 * VITE_. Keep the dataset PRIVATE and add no CORS origin for the web app, so
 * that even someone who learns the project id cannot read or query it.
 *
 * Every read goes to the live API (useCdn: false). The CDN is eventually
 * consistent, and a verification that read a stale code counter could
 * report a genuine pack as a duplicate.
 */
import { createClient } from '@sanity/client';

export class SanityBackend {
  constructor({ projectId, dataset, token, apiVersion }) {
    this.client = createClient({
      projectId,
      dataset,
      token,
      apiVersion,
      useCdn: false,
      // Only published documents. The application never writes drafts; this
      // keeps a half-edited Studio draft from ever being read as data.
      perspective: 'published',
      // No request tagging with anything identifying; and never log the token.
      requestTagPrefix: 'qrshield',
    });
    this.dataset = dataset;
  }

  get name() {
    return `Sanity (dataset "${this.dataset}")`;
  }

  fetch(query, params = {}) {
    return this.client.fetch(query, params);
  }

  getDocument(id) {
    return this.client.getDocument(id).then((d) => d ?? null);
  }

  async getDocuments(ids) {
    if (!ids.length) return [];
    const docs = await this.client.getDocuments(ids);
    return docs.map((d) => d ?? null);
  }

  /**
   * One Sanity transaction: every mutation applies, or none does.
   *
   * visibility 'sync' waits until the change is visible to queries, so a read
   * straight after a write - which the application does constantly - sees it.
   */
  async mutate(mutations) {
    if (!mutations.length) return [];
    const docs = await this.client.mutate(mutations, {
      returnDocuments: true,
      returnFirst: false,
      visibility: 'sync',
      autoGenerateArrayKeys: false,
    });

    /*
     * The API returns one result per DOCUMENT the transaction touched, not
     * one per mutation: two mutations on one document (create a counter if
     * missing, then increment it) come back as a single result. Callers get
     * one entry per mutation, as the memory backend gives them - each being
     * that document's state after the transaction, or null if it is gone.
     */
    const byId = new Map();
    for (const d of docs ?? []) if (d?._id) byId.set(d._id, d);
    return mutations.map((m) => {
      const [op, body] = Object.entries(m)[0];
      if (op === 'delete') return null;
      return byId.get(op === 'patch' ? body.id : body._id) ?? null;
    });
  }

  async close() {
    /* HTTP client: nothing held open */
  }
}

export default SanityBackend;
