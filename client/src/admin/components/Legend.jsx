/**
 * The legend: what every badge, colour and icon on the staff screens means.
 *
 * Opened from the Overview. Each symbol is drawn by the same component the
 * screens draw it with (StatusBadge, ResultBadge, ...), so its colour and
 * wording can never drift from what staff see; only the explanations are
 * written here. The sidebar icons come from the shell's own route list.
 *
 * A section about a screen the signed-in person cannot open is left out, as
 * the sidebar leaves the screen out.
 */
import { createContext, useContext, useState } from 'react';

import { humanise } from '../../lib/format.js';
import { useSession } from '../../lib/hooks.jsx';
import { Icon } from '../../components/Icons.jsx';
import { useDrawer } from './Drawer.jsx';
import { PlaceCheckBadge, ResultBadge, SeverityBadge, StatusBadge } from './ui.jsx';

/** The sidebar entries this person can open, provided by the shell. */
export const NavContext = createContext([]);

/** What each sidebar entry is for, by its path. */
const NAV_TEXT = {
  '': 'Overview: the day at a glance.',
  alerts: 'Alerts: suspicious activity to investigate.',
  scans: 'Scan log: every check of a pack.',
  reports: 'Patient reports: problems patients have reported.',
  customers: 'Customers: the people who check packs.',
  lookup: 'Code lookup: everything about one pack code.',
  products: 'Products: medicines and their leaflets.',
  'leaflet-codes': 'Leaflet QR codes: the QR on each carton that opens its leaflet.',
  batches: 'Batches & codes: production runs and their codes.',
  shipments: 'Shipments: where batches were sent.',
  compliance: 'Compliance: summary figures for reporting.',
  audit: 'Audit log: every action taken by staff.',
  users: 'Users: staff accounts.',
  settings: 'Settings: system settings.',
};

const word = (text) => <span className="legend-key-word">{text}</span>;
const reason = (r) => word(humanise(r));

/** Every section, in the order a person meets them. `needs`: any one of these permissions. */
function sections(nav) {
  return [
    {
      id: 'overview',
      title: 'On the Overview',
      note: 'Pilot and sandbox batches are left out of every figure on the Overview.',
      rows: [
        {
          term: 'Up or down arrow and percentage',
          symbol: <span className="legend-key-tile">↗ +12%</span>,
          text: 'Up or down on the previous 30 days. The same colour either way - read the arrow and the figure.',
        },
        {
          term: 'Corner arrow',
          symbol: (
            <span className="legend-key-tile legend-key-tile-link">
              <Icon name="arrow-right" />
            </span>
          ),
          text: 'Opens the section behind that figure.',
        },
        {
          term: 'Blue bar',
          symbol: <span className="legend-key-swatch is-genuine" />,
          text: 'Genuine checks, in the Verification volume chart.',
        },
        {
          term: 'Red bar',
          symbol: <span className="legend-key-swatch is-flagged" />,
          text: 'Flagged checks, stacked on top of the genuine ones.',
        },
      ],
    },
    {
      id: 'results',
      title: 'Check results',
      rows: [
        {
          term: 'Genuine',
          symbol: <ResultBadge result="genuine" />,
          text: "The code is on record, its batch is released and in date, and it hasn't already been verified elsewhere.",
        },
        {
          term: 'Flagged',
          symbol: <ResultBadge result="flagged" />,
          text: 'Something is wrong with the pack or its code - the reason says what. Treat the pack as suspect.',
        },
        {
          term: 'Invalid',
          symbol: <ResultBadge result="invalid" />,
          text: 'The code is mistyped or not in the right format. Usually a typo rather than a fake, so the person is asked to try again.',
        },
        {
          term: 'Blue dot',
          symbol: <span className="tl-dot genuine" />,
          text: 'In a history: a genuine check, or all in order.',
        },
        {
          term: 'Red dot',
          symbol: <span className="tl-dot flagged" />,
          text: 'In a history: a flagged check, or a recalled batch.',
        },
        {
          term: 'Amber dot',
          symbol: <span className="tl-dot invalid" />,
          text: 'In a history: an invalid check - or, on your account page, a sign-in on another device.',
        },
      ],
    },
    {
      id: 'reasons',
      title: 'Why a check came out that way',
      note: 'The Reason column of the scan log, and each check in Code lookup.',
      needs: ['scans:read', 'codes:read'],
      rows: [
        { term: 'ok', symbol: reason('ok'), text: 'Genuine - the first time this pack was verified.' },
        {
          term: 'ok repeat same source',
          symbol: reason('ok_repeat_same_source'),
          text: 'Genuine - the same person checking their own pack again.',
        },
        { term: 'checksum failed', symbol: reason('checksum_failed'), text: 'Invalid - one character is wrong, most likely a typo.' },
        {
          term: 'malformed',
          symbol: reason('malformed'),
          text: 'Invalid - not in the code format, which looks like AMX25-7KQ2M9-K7 (older packs: AMX25-260921-00483-K7).',
        },
        {
          term: 'unknown code',
          symbol: reason('unknown_code'),
          text: "Flagged - correctly formed, but not in the registry. A possible counterfeit.",
        },
        {
          term: 'duplicate scan',
          symbol: reason('duplicate_scan'),
          text: 'Flagged - already verified by someone else. The pack may have been copied.',
        },
        { term: 'recalled', symbol: reason('recalled'), text: 'Flagged - the batch has been recalled.' },
        { term: 'void', symbol: reason('void'), text: 'Flagged - this code has been withdrawn.' },
        {
          term: 'not released',
          symbol: reason('not_released'),
          text: 'Flagged - the code exists, but its batch was never released for sale.',
        },
        { term: 'expired', symbol: reason('expired'), text: "Flagged - the pack is past its batch's expiry date." },
      ],
    },
    {
      id: 'how',
      title: 'How a check was made',
      note: 'The Channel column of the scan log, and each check in Code lookup.',
      needs: ['scans:read', 'codes:read'],
      rows: [
        { term: 'web', symbol: word('web'), text: 'On the website, typed in or scanned with the camera.' },
        { term: 'sms', symbol: word('sms'), text: 'By text message.' },
        { term: 'api', symbol: word('api'), text: 'By another system, through the API.' },
        { term: 'QR signature valid', symbol: word('QR signature valid'), text: 'Scanned from a genuine printed QR code.' },
        {
          term: 'QR signature invalid',
          symbol: word('QR signature invalid'),
          text: "The QR carried a signature that doesn't match. The QR itself may be fake.",
        },
        {
          term: 'QR signature absent',
          symbol: word('QR signature absent'),
          text: 'Typed in by hand, so there was no QR to check.',
        },
      ],
    },
    {
      id: 'severity',
      title: 'Alert severity',
      note: 'Each alert type starts at a set level. Repeats on the same incident raise it: 3 make it at least high, 10 make it critical.',
      needs: ['alerts:read'],
      rows: [
        {
          term: 'critical',
          symbol: <SeverityBadge severity="critical" />,
          text: 'Act now - for example, a recalled batch scanned by a patient.',
        },
        {
          term: 'high',
          symbol: <SeverityBadge severity="high" />,
          text: 'Urgent - for example, a duplicate scan, code-guessing or a patient report.',
        },
        { term: 'medium', symbol: <SeverityBadge severity="medium" />, text: 'Look into it soon - for example, an unknown code.' },
        { term: 'low', symbol: <SeverityBadge severity="low" />, text: 'For the record - for example, an expired pack was checked.' },
      ],
    },
    {
      id: 'alert-status',
      title: 'Alert status',
      needs: ['alerts:read'],
      rows: [
        { term: 'open', symbol: <StatusBadge status="open" />, text: 'Nobody has picked it up yet.' },
        { term: 'investigating', symbol: <StatusBadge status="investigating" />, text: 'Someone is looking into it.' },
        { term: 'resolved', symbol: <StatusBadge status="resolved" />, text: 'Dealt with.' },
        { term: 'dismissed', symbol: <StatusBadge status="dismissed" />, text: 'Checked, and not a problem.' },
      ],
    },
    {
      id: 'alert-types',
      title: 'Alert types',
      needs: ['alerts:read'],
      rows: [
        { term: 'duplicate scan', symbol: reason('duplicate_scan'), text: 'One code verified from more than one place. Starts high.' },
        {
          term: 'unknown code',
          symbol: reason('unknown_code'),
          text: "A correctly formed code that isn't in the registry was checked. Starts medium.",
        },
        { term: 'recalled scan', symbol: reason('recalled_scan'), text: 'A pack from a recalled batch was checked. Starts critical.' },
        { term: 'expired scan', symbol: reason('expired_scan'), text: 'A pack past its expiry date was checked. Starts low.' },
        {
          term: 'guess attack',
          symbol: reason('guess_attack'),
          text: 'Many failed look-ups from one source - someone may be guessing codes. Starts high.',
        },
        { term: 'consumer report', symbol: reason('consumer_report'), text: 'A patient reported a problem with a pack. Starts high.' },
        {
          term: 'batch anomaly',
          symbol: reason('batch_anomaly'),
          text: 'A withdrawn code, or one from a batch never released, was checked. Starts medium.',
        },
      ],
    },
    {
      id: 'batches',
      title: 'Batch status',
      note: 'A batch moves from planned to closed in this order. It can be recalled any time from printed onwards.',
      needs: ['batches:read'],
      rows: [
        { term: 'planned', symbol: <StatusBadge status="planned" />, text: 'Created, with no codes yet. It can still be removed to fix a mistake.' },
        {
          term: 'codes issued',
          symbol: <StatusBadge status="codes_issued" />,
          text: "A code made for every unit. From here the batch can't be removed.",
        },
        {
          term: 'printed',
          symbol: <StatusBadge status="printed" />,
          text: 'Codes printed on the packs. Checks still come out flagged, as not released.',
        },
        { term: 'released', symbol: <StatusBadge status="released" />, text: 'Released for sale. Its packs check as genuine.' },
        { term: 'distributed', symbol: <StatusBadge status="distributed" />, text: 'Out in the supply chain.' },
        { term: 'recalled', symbol: <StatusBadge status="recalled" />, text: 'Withdrawn. Every check of its packs warns the patient.' },
        { term: 'closed', symbol: <StatusBadge status="closed" />, text: 'Finished, and kept for the record.' },
        {
          term: 'pilot',
          symbol: <span className="badge badge-neutral">pilot</span>,
          text: 'A pilot or sandbox batch. Left out of lists and Overview figures unless "Include pilot batches" is ticked.',
        },
      ],
    },
    {
      id: 'codes',
      title: 'Code status',
      note: 'One pack\'s code, in Code lookup and in a batch\'s code counts.',
      needs: ['codes:read', 'batches:read'],
      rows: [
        { term: 'issued', symbol: <StatusBadge status="issued" />, text: 'Made, not yet printed.' },
        { term: 'printed', symbol: <StatusBadge status="printed" />, text: "Printed on a pack; the batch isn't released yet." },
        { term: 'released', symbol: <StatusBadge status="released" />, text: 'On a pack that is for sale.' },
        { term: 'verified', symbol: <StatusBadge status="verified" />, text: 'A patient has checked this pack and it came out genuine.' },
        {
          term: 'flagged',
          symbol: <StatusBadge status="flagged" />,
          text: 'A check of this pack came out flagged - see its history in Code lookup.',
        },
        { term: 'recalled', symbol: <StatusBadge status="recalled" />, text: 'Its batch has been recalled.' },
        { term: 'void', symbol: <StatusBadge status="void" />, text: 'Withdrawn - for example, a pack destroyed or stolen. Any check is flagged.' },
      ],
    },
    {
      id: 'place',
      title: 'Where a pack was bought',
      note: 'Where the person says they bought it, against where they checked it. A lead to look into, not proof - people travel.',
      needs: ['scans:read', 'alerts:read', 'reports:read'],
      rows: [
        { term: 'Nearby', symbol: <PlaceCheckBadge consistency="nearby" />, text: 'Within 50 km of where it was checked.' },
        {
          term: 'Plausible',
          symbol: <PlaceCheckBadge consistency="plausible" />,
          text: '50 to 300 km apart in the same island group - or, without GPS, simply the same island group.',
        },
        {
          term: 'Inconsistent',
          symbol: <PlaceCheckBadge consistency="inconsistent" />,
          text: 'More than 300 km apart, or in different island groups (Luzon, Visayas, Mindanao).',
        },
        { term: 'GPS', symbol: word('GPS'), text: "The person shared their phone's location. Accurate to the city." },
        {
          term: 'connection-based, approximate',
          symbol: word('connection-based, approximate'),
          text: 'Worked out from their internet connection. Can be well off, especially on mobile data.',
        },
      ],
    },
    {
      id: 'reports',
      title: 'Patient report status',
      note: 'The number beside Patient reports in the sidebar counts new reports.',
      needs: ['reports:read'],
      rows: [
        { term: 'new', symbol: <StatusBadge status="new" />, text: 'Not looked at yet.' },
        { term: 'reviewing', symbol: <StatusBadge status="reviewing" />, text: 'Someone is looking into it.' },
        { term: 'closed', symbol: <StatusBadge status="closed" />, text: 'Dealt with.' },
      ],
    },
    {
      id: 'products',
      title: 'Products and leaflets',
      needs: ['products:read'],
      rows: [
        { term: 'active', symbol: <StatusBadge status="active" />, text: 'A medicine in production.' },
        { term: 'discontinued', symbol: <StatusBadge status="discontinued" />, text: 'No longer made.' },
        {
          term: 'Not published',
          symbol: <span className="badge badge-warn">Not published</span>,
          text: 'The medicine has no leaflet yet, so its leaflet QR has nothing to show.',
        },
      ],
    },
    {
      id: 'customers',
      title: 'Customers',
      needs: ['scans:read'],
      rows: [
        {
          term: 'browsers',
          symbol: <span className="badge badge-neutral">2 browsers</span>,
          text: 'The person gave their details from this many browsers or phones.',
        },
        {
          term: 'flagged',
          symbol: <span className="badge badge-danger">3 flagged</span>,
          text: 'This many of their checks came out flagged.',
        },
      ],
    },
    {
      id: 'staff',
      title: 'Staff accounts',
      rows: [
        {
          term: 'admin',
          symbol: <span className="badge badge-neutral">admin</span>,
          text: 'Everything, including staff accounts and settings.',
        },
        {
          term: 'security',
          symbol: <span className="badge badge-neutral">security</span>,
          text: 'All the investigation screens, but not staff accounts or settings.',
        },
        {
          term: 'regulator',
          symbol: <span className="badge badge-neutral">regulator</span>,
          text: "Summary and compliance figures only - not individual patients' checks.",
        },
        { term: 'active', symbol: <StatusBadge status="active" />, text: 'The account can sign in.' },
        { term: 'suspended', symbol: <StatusBadge status="suspended" />, text: 'The account cannot sign in.' },
        { term: 'you', symbol: <span className="badge badge-info">you</span>, text: 'Your own account.' },
      ],
    },
    {
      id: 'import',
      title: 'Importing a spreadsheet',
      note: 'The summary shown before a spreadsheet of products or batches is imported. Nothing is saved until you confirm.',
      needs: ['products:write', 'batches:write'],
      rows: [
        { term: 'to add', symbol: <span className="badge badge-good">4 to add</span>, text: 'New records the file will add.' },
        { term: 'to update', symbol: <span className="badge badge-info">2 to update</span>, text: 'Existing records the file will change.' },
        {
          term: 'cannot be read',
          symbol: <span className="badge badge-danger">1 cannot be read</span>,
          text: 'Rows with a problem, listed underneath by their row number in the spreadsheet. They are skipped; the rest can still be imported.',
        },
        {
          term: 'nothing to import',
          symbol: <span className="badge badge-neutral">nothing to import</span>,
          text: 'The file would change nothing.',
        },
      ],
    },
    {
      id: 'nav',
      title: 'Sidebar and top bar',
      rows: [
        ...nav.map((r) => ({
          term: r.label,
          symbol: <Icon name={r.icon} />,
          text: NAV_TEXT[r.path] ?? r.label,
        })),
        {
          term: 'count',
          symbol: <span className="nav-count">3</span>,
          text: 'Beside Alerts: open and investigating alerts. Beside Patient reports: new reports.',
        },
        {
          term: 'theme',
          symbol: (
            <span className="legend-key-icons">
              <Icon name="sun" />
              <Icon name="moon" />
            </span>
          ),
          text: 'Switch between the light and dark theme.',
        },
        { term: 'sign out', symbol: <Icon name="out" />, text: 'Sign out.' },
      ],
    },
  ];
}

/** The body of the legend, with a box to find a word in it. */
function Legend({ nav, permissions }) {
  const [find, setFind] = useState('');
  const q = find.trim().toLowerCase();
  const allowed = (needs) => !needs || needs.some((p) => permissions.includes(p));

  const shown = sections(nav)
    .filter((s) => allowed(s.needs))
    .map((s) => ({
      ...s,
      rows: q ? s.rows.filter((r) => `${s.title} ${r.term} ${r.text}`.toLowerCase().includes(q)) : s.rows,
    }))
    .filter((s) => s.rows.length);

  return (
    <div className="legend-key">
      <input
        className="input"
        id="legendFind"
        type="search"
        value={find}
        onChange={(e) => setFind(e.target.value)}
        placeholder="Find a word, e.g. recalled"
        aria-label="Find in the legend"
        autoComplete="off"
      />
      {!shown.length && <p className="text-muted">Nothing in the legend matches "{find.trim()}".</p>}
      {shown.map((s) => (
        <section key={s.id} className="legend-key-section" aria-labelledby={`legend-${s.id}`}>
          <h3 id={`legend-${s.id}`}>{s.title}</h3>
          {s.note && <p className="text-sm text-muted">{s.note}</p>}
          <dl className="legend-key-rows">
            {s.rows.map((r) => (
              <div key={r.term}>
                <dt>{r.symbol}</dt>
                <dd>{r.text}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

/** The button that opens the legend. */
export function LegendButton() {
  const { open } = useDrawer();
  const nav = useContext(NavContext);
  const session = useSession();
  const permissions = session?.user?.permissions ?? [];

  return (
    <button
      className="btn btn-sm"
      type="button"
      onClick={() =>
        open({
          title: 'Legend',
          subtitle: 'What the badges, colours and icons on these screens mean.',
          body: <Legend nav={nav} permissions={permissions} />,
        })
      }
    >
      <Icon name="help" />
      Legend
    </button>
  );
}
