/**
 * The patient information leaflet for one medicine, on its own page.
 *
 * This is what a leaflet QR opens - the one printed on a shelf talker, a
 * poster or a carton. It is reached WITHOUT a pack code, and that shapes the
 * whole page:
 *
 * It must not imply the pack in the reader's hand is genuine. A leaflet QR is
 * a link printed on packaging, and packaging is exactly what a counterfeiter
 * copies - so this page says nothing about authenticity and instead points at
 * the check that does, which needs the unique code on the pack.
 */
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import { useApi } from '../lib/hooks.jsx';
import { fmtDate } from '../lib/format.js';
import { Icon } from '../components/Icons.jsx';
import { Logo } from '../components/Logo.jsx';
import BrandLoader from '../components/BrandLoader.jsx';

export default function LeafletPage() {
  const { sku } = useParams();
  const [params] = useSearchParams();
  const lang = params.get('lang') ?? 'en';

  const { data, error, loading } = useApi(
    `/api/product/${encodeURIComponent(sku)}/leaflet`,
    { query: { lang } },
    [sku, lang]
  );

  return (
    <>
      <header className="portal-header">
        <div className="wrap">
          <Link className="brand" to="/" aria-label="Orbit - check your medicine">
            <Logo size="sm" />
          </Link>
        </div>
      </header>

      <main className="wrap portal-main" id="main">
        {loading && <BrandLoader message="Opening the leaflet..." />}

        {error && (
          <div className="card card-pad">
            <div className="alert alert-warn">
              <Icon name="alert" />
              <span>
                {error.status === 404
                  ? 'There is no published leaflet for this medicine yet.'
                  : 'The leaflet could not be loaded. Please try again.'}
              </span>
            </div>
            <p className="text-sm text-muted mt-16">
              If you were checking whether a pack is genuine, use the code printed on the pack
              itself - <Link to="/">check a pack here</Link>.
            </p>
          </div>
        )}

        {data && <LeafletBody data={data} />}
      </main>
    </>
  );
}

function LeafletBody({ data }) {
  const { product, leaflet } = data;
  // The first section starts open: a leaflet that opens fully collapsed looks
  // like an empty page on a phone.
  const [open, setOpen] = useState(0);

  return (
    <article className="card">
      <div className="card-body">
        <h1 className="leaflet-title">
          {product.name}
          {product.strength ? ` ${product.strength}` : ''}
        </h1>
        <p className="text-sm text-muted mt-8">
          {[product.dosageForm, product.manufacturer].filter(Boolean).join(' · ')}
        </p>
      </div>

      {/*
        Stated plainly and before the leaflet, not after it. Someone who
        scanned a code on a carton may believe that act verified the pack;
        this page is the only place to correct that, and it is only useful
        above the content they came to read.
      */}
      <div className="card-body pt-0">
        <div className="alert alert-info">
          <Icon name="shield" />
          <span>
            This is product information only. It does <strong>not</strong> confirm that your pack
            is genuine - for that, <Link to="/">check the unique code printed on the pack</Link>.
          </span>
        </div>
      </div>

      <div className="leaflet">
        <div className="card-head">
          <h2>Patient information leaflet</h2>
          <span className="badge badge-neutral">v{leaflet.version}</span>
        </div>

        {leaflet.sections.map((section, i) => (
          <div className="leaflet-section" key={`${section.heading}-${i}`}>
            <button
              className="leaflet-toggle"
              type="button"
              aria-expanded={open === i}
              aria-controls={`leaflet-body-${i}`}
              onClick={() => setOpen(open === i ? -1 : i)}
            >
              <span>{section.heading}</span>
              <Icon name="chevron" />
            </button>
            {open === i && (
              <div className="leaflet-body" id={`leaflet-body-${i}`}>
                {section.body}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="card-body">
        <p className="text-sm text-muted">
          Leaflet version {leaflet.version}
          {data.leaflet.effectiveFrom ? `, effective ${fmtDate(data.leaflet.effectiveFrom)}` : ''}.
          Always follow the advice of your doctor or pharmacist.
        </p>
      </div>
    </article>
  );
}
