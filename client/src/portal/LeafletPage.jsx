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
 *
 * Versions. Publishing a new leaflet supersedes the old one, and this page
 * shows the newest by default: a safety correction has to reach everyone
 * holding the medicine, including packs printed before it. Older versions
 * are reachable by ?version= and are marked as superseded ABOVE the content,
 * so nobody reads outdated dosing without being told first.
 */
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import { useApi } from '../lib/hooks.jsx';
import { fmtDate } from '../lib/format.js';
import { Icon } from '../components/Icons.jsx';
import { Logo } from '../components/Logo.jsx';
import BrandLoader from '../components/BrandLoader.jsx';

/**
 * The address of one version of a leaflet - or of the current one when no
 * version is given. The current version's address carries no version, so it
 * is the same address the QR encodes and never goes stale.
 */
function leafletHref(sku, { lang, version, view } = {}) {
  const q = new URLSearchParams();
  if (lang && lang !== 'en') q.set('lang', lang);
  if (version) q.set('version', version);
  if (view) q.set('view', view);
  const s = q.toString();
  return `/leaflet/${encodeURIComponent(sku)}${s ? `?${s}` : ''}`;
}

export default function LeafletPage() {
  const { sku } = useParams();
  const [params] = useSearchParams();
  const lang = params.get('lang') ?? 'en';
  const version = params.get('version') ?? undefined;

  const { data, error, loading } = useApi(
    `/api/product/${encodeURIComponent(sku)}/leaflet`,
    { query: { lang, version } },
    [sku, lang, version]
  );

  /*
   * A leaflet published as a PDF opens as the PDF, at once: that is what the
   * QR on the carton promises. Only the current version does so - an older
   * one is reached deliberately, through the history, and keeps its
   * superseded warning in front of it - and ?view=text asks for the page
   * instead, which is the only form a screen reader can read.
   */
  const pdf = data?.leaflet?.pdf ?? null;
  const opensPdf = Boolean(pdf && !data.leaflet.superseded && params.get('view') !== 'text');
  useEffect(() => {
    if (opensPdf) window.location.replace(pdf.url);
  }, [opensPdf, pdf]);

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
                {error.status === 404 && version
                  ? 'That version of the leaflet is not available.'
                  : error.status === 404
                    ? 'There is no published leaflet for this medicine yet.'
                    : 'The leaflet could not be loaded. Please try again.'}
              </span>
            </div>
            {error.status === 404 && version && (
              <p className="text-sm text-muted mt-16">
                <Link to={leafletHref(sku, { lang })}>Read the current version instead</Link>.
              </p>
            )}
            <p className="text-sm text-muted mt-16">
              If you were checking whether a pack is genuine, use the code printed on the pack
              itself - <Link to="/">check a pack here</Link>.
            </p>
          </div>
        )}

        {/* Keyed on the version so the open-section state resets when the
            reader switches versions - section 4 of one version is not
            section 4 of another. */}
        {data && opensPdf && (
          <div className="card card-pad">
            <BrandLoader message="Opening the leaflet (PDF)..." />
            <p className="text-sm text-muted mt-16">
              If it does not open, <a href={pdf.url}>open the PDF here</a>
              {data.leaflet.sections.length > 0 && (
                <>
                  , or <Link to={leafletHref(sku, { lang, view: 'text' })}>read it as text</Link>
                </>
              )}
              .
            </p>
          </div>
        )}
        {data && !opensPdf && <LeafletBody key={data.leaflet.version} data={data} lang={lang} />}
      </main>
    </>
  );
}

function LeafletBody({ data, lang }) {
  const { product, leaflet, history = [] } = data;
  const current = history.find((h) => h.current);
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

      {/*
        Also before the content, for the same reason. A superseded leaflet is
        the one thing on this page that could mislead someone about their
        medicine, and it must be impossible to reach the dosing text without
        passing this.
      */}
      {leaflet.superseded && (
        <div className="card-body pt-0">
          <div className="alert alert-warn" role="status">
            <Icon name="alert" />
            <span>
              You are reading an <strong>older version</strong> of this leaflet (v{leaflet.version},
              effective {fmtDate(leaflet.effectiveFrom)}). It has been replaced
              {current ? (
                <>
                  {' '}by version {current.version} -{' '}
                  <Link to={leafletHref(product.sku, { lang })}>read the current version</Link>.
                </>
              ) : (
                '.'
              )}
            </span>
          </div>
        </div>
      )}

      <div className="leaflet">
        <div className="card-head">
          <h2>Patient information leaflet</h2>
          <span className={`badge ${leaflet.superseded ? 'badge-warn' : 'badge-neutral'}`}>
            v{leaflet.version}
            {leaflet.superseded ? ' · superseded' : ''}
          </span>
        </div>

        {/* The document itself, when this version has one. Opened in a new
            tab so a superseded version's warning stays behind it. */}
        {leaflet.pdf && (
          <div className="card-body">
            <a className="btn btn-primary" href={leaflet.pdf.url} target="_blank" rel="noopener">
              <Icon name="download" /> Open the leaflet (PDF)
            </a>
            {!leaflet.sections.length && (
              <p className="text-sm text-muted mt-8">This version is provided as a PDF document.</p>
            )}
          </div>
        )}

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
          {leaflet.effectiveFrom ? `, effective ${fmtDate(leaflet.effectiveFrom)}` : ''}.
          Always follow the advice of your doctor or pharmacist.
        </p>

        {/* Only offered when there is more than one version to choose from;
            a single-version leaflet has no history to show. */}
        {history.length > 1 && (
          <div className="mt-16">
            <p className="text-sm">
              <strong>Versions of this leaflet</strong>
            </p>
            {history.map((h) => (
              <p className="text-sm text-muted mt-8" key={h.version}>
                {h.version === leaflet.version ? (
                  <span>v{h.version}</span>
                ) : (
                  <Link
                    to={leafletHref(product.sku, {
                      lang,
                      version: h.current ? undefined : h.version,
                    })}
                  >
                    v{h.version}
                  </Link>
                )}
                {' - '}
                {h.current ? 'current' : 'superseded'}, effective {fmtDate(h.effectiveFrom)}
                {h.version === leaflet.version ? ' (you are reading this one)' : ''}
              </p>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
