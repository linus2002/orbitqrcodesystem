# Brand assets

`il-logo.png` is the master mark, at full resolution. It is deliberately NOT
in `client/public/`: everything under that directory is copied into the build
and served, and at 956KB this file would be downloaded by every patient
opening the verification portal on a phone — for a mark displayed at 30px.

The sizes the app actually serves live in `client/public/img/` and are
generated from this one:

| File | Size | Used by |
|---|---|---|
| `logo-mark-192.png` | 12KB | the lockup and the loading animation |
| `favicon-32.png` | 1.8KB | the browser tab |
| `apple-touch-icon.png` | 10.5KB | an iOS home-screen shortcut |

To regenerate them after the mark changes:

```bash
npm install --no-save sharp
node -e "
const sharp = require('sharp');
const src = 'brand/il-logo.png';
const out = [
  ['client/public/img/logo-mark-192.png', 192],
  ['client/public/img/favicon-32.png', 32],
  ['client/public/img/apple-touch-icon.png', 180],
];
(async () => {
  for (const [path, size] of out) {
    await sharp(src)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9, palette: true })
      .toFile(path);
    console.log(path, size + 'px');
  }
})();
"
```

`sharp` is installed with `--no-save` on purpose: it is needed for this one
step and has no place in the dependencies of a running server.
