/**
 * Your own profile: display name and picture.
 *
 * Only those two. Email is a login credential and role is the entire access
 * model, so both stay with an administrator - a person editing their own role
 * would not be editing a profile, they would be granting themselves access.
 * The screen says so rather than just omitting the fields, because a missing
 * field reads as an oversight.
 *
 * THE PICTURE IS RESIZED HERE, IN THE BROWSER, before it is sent. A phone
 * camera photo is several megabytes and 4000px wide, for something displayed
 * at 46px. Downscaling first means the upload is ~30KB instead of ~4MB, which
 * matters on the connections this system is used on. The server still checks
 * the size and type; this is for the person waiting, not for safety.
 */
import { useRef, useState } from 'react';

import { api } from '../../lib/api.js';
import { useSession, useToast } from '../../lib/hooks.jsx';
import { initials } from '../../lib/format.js';
import { Icon } from '../../components/Icons.jsx';

/** What the avatar is stored and displayed at. */
const AVATAR_PX = 256;

/**
 * Draw the chosen file into a square canvas and return a JPEG data URL.
 *
 * Centre-cropped rather than squashed: a portrait photo stretched into a
 * square makes a face look wrong, and the crop is what a round avatar would
 * show anyway.
 */
async function toSquareDataUrl(file) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;

  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_PX;
  canvas.height = AVATAR_PX;

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
  bitmap.close?.();

  return canvas.toDataURL('image/jpeg', 0.85);
}

export default function ProfileEditor() {
  const session = useSession();
  const toast = useToast();
  const fileInput = useRef(null);

  const [fullName, setFullName] = useState(session.user.fullName ?? '');
  const [avatar, setAvatar] = useState(session.user.avatar ?? null);
  const [busy, setBusy] = useState(false);

  const dirty =
    fullName.trim() !== (session.user.fullName ?? '') ||
    (avatar ?? null) !== (session.user.avatar ?? null);

  async function pick(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast('Choose an image file.', 'error');
      return;
    }
    try {
      setAvatar(await toSquareDataUrl(file));
    } catch {
      toast('That image could not be read.', 'error');
    } finally {
      // Let the same file be chosen again after a change of mind.
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function save(e) {
    e.preventDefault();
    if (!fullName.trim()) {
      toast('Your name cannot be empty.', 'error');
      return;
    }

    setBusy(true);
    try {
      await api('/api/auth/profile', {
        method: 'PATCH',
        body: { fullName: fullName.trim(), avatar },
      });
      // Re-read the session so the sidebar and every other screen showing your
      // name or picture updates without a reload.
      await session.refresh();
      toast('Profile updated.', 'success');
    } catch (err) {
      toast(err.formMessage ?? 'Could not save your profile.', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card-body profile-editor" onSubmit={save}>
      <div className="profile-avatar-row">
        <span className="profile-avatar">
          {avatar ? (
            <img src={avatar} alt="" width={AVATAR_PX} height={AVATAR_PX} />
          ) : (
            initials(fullName || session.user.email)
          )}
        </span>

        <div className="profile-avatar-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
          >
            <Icon name="upload" />
            {avatar ? 'Change picture' : 'Upload picture'}
          </button>
          {avatar && (
            <button
              type="button"
              className="btn btn-sm btn-quiet"
              onClick={() => setAvatar(null)}
              disabled={busy}
            >
              Remove
            </button>
          )}
          <p className="hint">
            JPEG, PNG or WebP. It is cropped square and scaled down to {AVATAR_PX}px before
            it is sent.
          </p>
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            onChange={(e) => pick(e.target.files?.[0])}
          />
        </div>
      </div>

      <div className="field mt-16">
        <label className="label" htmlFor="profile-name">
          Display name
        </label>
        <input
          id="profile-name"
          className="input"
          value={fullName}
          maxLength={120}
          onChange={(e) => setFullName(e.target.value)}
          disabled={busy}
        />
        <p className="hint">This is the name shown on the audit log beside everything you do.</p>
      </div>

      <div className="field mt-16">
        <label className="label" htmlFor="profile-email">
          Email
        </label>
        <input id="profile-email" className="input" value={session.user.email} disabled readOnly />
        <p className="hint">
          Your email is how you sign in, and your role decides what you can reach. An
          administrator changes both - ask one if either is wrong.
        </p>
      </div>

      <div className="row mt-16">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !dirty}>
          {busy ? 'Saving...' : 'Save changes'}
        </button>
        {dirty && !busy && <span className="text-sm text-muted">You have unsaved changes.</span>}
      </div>
    </form>
  );
}
