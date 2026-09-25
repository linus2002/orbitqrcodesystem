/**
 * Who is checking.
 *
 * Shown once per browser, in place of the check card, before a pack can be
 * checked. It asks for what a safety follow-up needs - a name, a mobile
 * number, an email - and how the person relates to the medicine, which is
 * what tells the security team whether a flagged pack is in a patient's hand
 * or on a pharmacy shelf.
 *
 * Consent is a real box, not small print: the server refuses the form
 * without it, and records when it was ticked.
 */
import { useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import { Icon } from '../components/Icons.jsx';
import PrivacyPolicy, { POLICY_VERSION } from './PrivacyPolicy.jsx';

/** Marks a field the form will not send without. */
const Required = () => <span className="text-muted">(required)</span>;

export const ROLE_OPTIONS = [
  ['patient', 'I am the patient'],
  ['caregiver', 'I care for the patient (family, carer)'],
  ['pharmacist', 'Pharmacist'],
  ['health_worker', 'Doctor, nurse or health worker'],
  ['retailer', 'Retailer or distributor'],
  ['other', 'Other'],
];

const EMPTY = {
  fullName: '',
  phone: '',
  email: '',
  role: '',
  city: '',
  purchaseLocation: '',
  consent: false,
};

/** "is required" reads oddly on its own; give the server's wording a subject. */
function friendly(field, message) {
  const label = {
    fullName: 'Your name',
    phone: 'Your mobile number',
    email: 'Your email address',
    role: 'This',
    consent: 'Your agreement',
  }[field];
  return label ? `${label} ${message}.` : message;
}

export default function DetailsForm({ pendingCode, onDone, supportPhone }) {
  const [fields, setFields] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);

  const set = (key) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setFields((f) => ({ ...f, [key]: value }));
    setErrors((er) => ({ ...er, [key]: undefined }));
  };

  async function submit(e) {
    e.preventDefault();
    setError(null);

    // The obvious gaps are caught here so the page answers instantly; the
    // server checks everything again and is the one that decides.
    const missing = {};
    if (fields.fullName.trim().length < 2) missing.fullName = 'Please enter your name.';
    if (!fields.phone.trim()) missing.phone = 'Please enter your mobile number.';
    if (!fields.email.trim()) missing.email = 'Please enter your email address.';
    if (!fields.role) missing.role = 'Please choose one.';
    if (!fields.consent) missing.consent = 'Please tick the box to continue.';
    if (Object.keys(missing).length) {
      setErrors(missing);
      return;
    }

    setBusy(true);
    try {
      const res = await api('/api/portal/details', {
        method: 'POST',
        body: {
          fullName: fields.fullName.trim(),
          phone: fields.phone.trim(),
          email: fields.email.trim(),
          role: fields.role,
          city: fields.city.trim() || null,
          purchaseLocation: fields.purchaseLocation.trim() || null,
          consent: fields.consent,
          policyVersion: POLICY_VERSION,
        },
      });
      onDone(res.checker);
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        const mapped = {};
        for (const [field, message] of Object.entries(err.fieldErrors)) {
          mapped[field] = friendly(field, message);
        }
        setErrors(mapped);
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Too many attempts from this device. Please wait a while and try again.');
      } else {
        setError(err.message || 'Could not save your details. Please try again.');
      }
      setBusy(false);
    }
  }

  const invalid = (key) => (errors[key] ? 'true' : undefined);

  return (
    <section className="card details-card" aria-labelledby="details-title">
      <h2 id="details-title">First, tell us who you are</h2>
      <p>
        It takes a minute, and only once on this phone. If a pack you check turns out to be
        counterfeit or recalled, this is how the brand security team reaches you.
      </p>

      <form className="details-form" onSubmit={submit} noValidate>
        <div className="field">
          <label className="label" htmlFor="dName">
            Full name <Required />
          </label>
          <input
            className="input"
            id="dName"
            value={fields.fullName}
            onChange={set('fullName')}
            maxLength={120}
            autoComplete="name"
            autoFocus
            aria-invalid={invalid('fullName')}
            aria-describedby={errors.fullName ? 'dNameErr' : undefined}
          />
          {errors.fullName && (
            <p className="field-error" id="dNameErr" role="alert">
              {errors.fullName}
            </p>
          )}
        </div>

        <div className="two-up">
          <div className="field">
            <label className="label" htmlFor="dPhone">
              Mobile number <Required />
            </label>
            <input
              className="input"
              id="dPhone"
              type="tel"
              inputMode="tel"
              value={fields.phone}
              onChange={set('phone')}
              maxLength={32}
              autoComplete="tel"
              placeholder="0917 123 4567"
              aria-invalid={invalid('phone')}
              aria-describedby={errors.phone ? 'dPhoneErr' : 'dPhoneHint'}
            />
            {errors.phone ? (
              <p className="field-error" id="dPhoneErr" role="alert">
                {errors.phone}
              </p>
            ) : (
              <p className="hint" id="dPhoneHint">
                For SMS. Your own number, not a landline.
              </p>
            )}
          </div>

          <div className="field">
            <label className="label" htmlFor="dEmail">
              Email address <Required />
            </label>
            <input
              className="input"
              id="dEmail"
              type="email"
              inputMode="email"
              value={fields.email}
              onChange={set('email')}
              maxLength={254}
              autoComplete="email"
              placeholder="name@gmail.com"
              aria-invalid={invalid('email')}
              aria-describedby={errors.email ? 'dEmailErr' : undefined}
            />
            {errors.email && (
              <p className="field-error" id="dEmailErr" role="alert">
                {errors.email}
              </p>
            )}
          </div>
        </div>

        <div className="field">
          <label className="label" htmlFor="dRole">
            Which of these are you? <Required />
          </label>
          <select
            className="select"
            id="dRole"
            value={fields.role}
            onChange={set('role')}
            aria-invalid={invalid('role')}
            aria-describedby={errors.role ? 'dRoleErr' : undefined}
          >
            <option value="">Choose one</option>
            {ROLE_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {errors.role && (
            <p className="field-error" id="dRoleErr" role="alert">
              {errors.role}
            </p>
          )}
        </div>

        <div className="two-up">
          <div className="field">
            <label className="label" htmlFor="dCity">
              City or municipality <span className="text-muted">(optional)</span>
            </label>
            <input
              className="input"
              id="dCity"
              value={fields.city}
              onChange={set('city')}
              maxLength={120}
              autoComplete="address-level2"
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="dWhere">
              Where did you get the medicine? <span className="text-muted">(optional)</span>
            </label>
            <input
              className="input"
              id="dWhere"
              value={fields.purchaseLocation}
              onChange={set('purchaseLocation')}
              maxLength={200}
              placeholder="Pharmacy or shop name"
            />
          </div>
        </div>

        <div className="field">
          <label className="consent" htmlFor="dConsent">
            <input
              type="checkbox"
              id="dConsent"
              checked={fields.consent}
              onChange={set('consent')}
              aria-invalid={invalid('consent')}
              aria-describedby={errors.consent ? 'dConsentErr' : 'dConsentHint'}
            />
            <span>
              I agree that Orbit may keep these details and contact me by SMS or email about the
              medicines I check.
            </span>
          </label>
          {errors.consent ? (
            <p className="field-error" id="dConsentErr" role="alert">
              {errors.consent}
            </p>
          ) : (
            <p className="hint" id="dConsentHint">
              Used by the brand security team for safety follow-up only.
            </p>
          )}
        </div>

        {error && (
          <div className="alert alert-error" role="alert">
            <Icon name="alert" />
            <span>{error}</span>
          </div>
        )}

        <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy}>
          {busy ? (
            <>
              <span className="spinner" aria-hidden="true" /> Saving...
            </>
          ) : (
            <>
              <Icon name="shield" />
              {pendingCode ? 'Continue and check this pack' : 'Continue to check my medicine'}
            </>
          )}
        </button>
      </form>
    </section>
  );
}
