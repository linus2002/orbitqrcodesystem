/**
 * A password input with a show/hide toggle.
 *
 * Takes every prop an <input> does (id, className, ref, autoComplete, value,
 * onChange...) and renders it inside a wrapper with the eye button, so the
 * sign-in page and the account page can keep their own input styling. The
 * button is a real button, outside the input's tab order for the field
 * itself: pressing Enter in the field still submits the form.
 */
import { useState } from 'react';
import { Icon } from './Icons.jsx';

export default function PasswordField({ className = 'input', ...props }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="pw-field">
      <input {...props} className={className} type={shown ? 'text' : 'password'} />
      <button
        className="pw-toggle"
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        // Keep focus in the field: Tab goes to the next control, not the eye.
        tabIndex={-1}
      >
        <Icon name={shown ? 'eye-off' : 'eye'} />
      </button>
    </div>
  );
}
