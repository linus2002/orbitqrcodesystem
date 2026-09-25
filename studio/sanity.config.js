/**
 * Sanity Studio for QR Shield - a read-only window onto the data.
 *
 * The project id and dataset come from studio/.env (SANITY_STUDIO_PROJECT_ID,
 * SANITY_STUDIO_DATASET), which is git-ignored: they are never committed.
 * Signing in to the Studio requires a Sanity account that is a member of the
 * project, and the dataset is private, so the id alone grants nothing.
 *
 * Nothing can be created, edited, published or deleted here. Every write
 * goes through the application, which enforces the audit trail, the batch
 * lifecycle, unique keys and field rules - a Studio edit would bypass all of
 * them. Change data through the dashboard; use this to look.
 */
import { defineConfig } from 'sanity';
import { structureTool } from 'sanity/structure';
import schemaTypes, { hiddenTypes } from './schemaTypes/generated.js';

const projectId = process.env.SANITY_STUDIO_PROJECT_ID;
const dataset = process.env.SANITY_STUDIO_DATASET || 'production';

if (!projectId) {
  throw new Error('Set SANITY_STUDIO_PROJECT_ID in studio/.env (see the README).');
}

export default defineConfig({
  name: 'default',
  title: 'QR Shield data',
  projectId,
  dataset,

  plugins: [
    structureTool({
      structure: (S) =>
        S.list()
          .title('QR Shield')
          .items(
            schemaTypes
              .filter((t) => !hiddenTypes.includes(t.name))
              .map((t) => S.documentTypeListItem(t.name).title(t.title))
          ),
    }),
  ],

  schema: { types: schemaTypes },

  document: {
    // Read-only: no publish, delete, duplicate or any other action...
    actions: () => [],
    // ...and no "create new document" anywhere.
    newDocumentOptions: () => [],
  },
});
