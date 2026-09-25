/**
 * The privacy notice behind the consent box.
 *
 * Shown in a modal from the details form, so a person can read what they are
 * agreeing to without leaving the form. The version is sent with the details
 * and stored against the person, so the record says which wording they saw.
 * Bump POLICY_VERSION whenever the text below changes in substance.
 *
 * A native <dialog>: the browser handles focus, Escape and the backdrop, and
 * screen readers announce it as a dialog, with no script beyond open/close.
 */
import { useEffect, useRef } from 'react';
import { Icon } from '../components/Icons.jsx';

export const POLICY_VERSION = '2026-09-25';

export default function PrivacyPolicy({ open, onClose, supportPhone }) {
  const ref = useRef(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      className="policy-dialog"
      ref={ref}
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself; a click
      // inside lands on the content. Only the former closes it.
      onClick={(e) => e.target === ref.current && onClose()}
      aria-labelledby="policyTitle"
    >
      <div className="policy-body">
        <div className="policy-head">
          <h2 id="policyTitle">How we use your details</h2>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <p className="text-sm text-muted">Privacy notice, version {POLICY_VERSION}.</p>

        <h3>What we ask for</h3>
        <p>
          Your name, mobile number and email address, and whether you are the patient, a
          pharmacist, a health worker or someone else. Your city and where you got the medicine,
          if you choose to give them. And a record of each pack you check: the code, the result,
          the time, and an approximate location worked out from your internet connection.
        </p>

        <h3>Why we need it</h3>
        <p>
          So the brand security team can reach you if a pack you checked turns out to be
          counterfeit or is recalled. So they can trace where suspect packs came from. And so they
          can reply if you report a problem with a pack.
        </p>

        <h3>Who can see it</h3>
        <p>
          The brand security team and the system administrators, and no one else. Regulators and
          auditors receive counts, never names. Your details are not sold, shared with other
          companies, or used for marketing.
        </p>

        <h3>How long we keep it</h3>
        <p>
          For as long as the medicines you checked could still be in use, then it is removed. You
          can ask for it to be removed sooner at any time.
        </p>

        <h3>Your rights</h3>
        <p>
          Under the Data Privacy Act of 2012 (Republic Act 10173) you may ask to see, correct or
          delete your details, or withdraw your agreement. To do so, contact the brand security
          team{supportPhone ? <> on <strong className="mono">{supportPhone}</strong></> : ''}. Withdrawing
          your agreement stops future contact; it does not undo a check already made.
        </p>

        <h3>How it is protected</h3>
        <p>
          Your details are kept in a database that only signed-in staff can reach. This phone is
          linked to them by a random key, and only a scrambled form of that key is stored, so the
          database on its own cannot be used to pose as you.
        </p>

        <p className="mt-16">
          <strong>By ticking the box, you agree to the above.</strong>
        </p>

        <button className="btn btn-primary btn-block mt-16" type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
