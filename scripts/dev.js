#!/usr/bin/env node
/**
 * Development: run the API and the Vite dev server together.
 *
 *   npm run dev
 *
 * Vite serves the React app on :5173 with hot module replacement and proxies
 * /api to the Express server, so cookies and same-origin requests behave
 * exactly as they do in production. Open the Vite URL, not the API one.
 *
 * Written by hand rather than pulling in `concurrently`, to keep the
 * dependency list short.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const isWindows = process.platform === 'win32';

/** Spawn a child, prefixing its output so the two streams stay readable. */
function run(name, command, args, color) {
  const child = spawn(command, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    // npm/vite are .cmd shims on Windows and need a shell to resolve.
    shell: isWindows,
  });

  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const forward = (stream, out) => {
    stream.on('data', (chunk) => {
      const text = chunk.toString().replace(/\n$/, '');
      if (text.trim()) out.write(text.split('\n').map((l) => prefix + l).join('\n') + '\n');
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`${prefix}exited with code ${code}`);
      shutdown(code);
    }
  });

  return child;
}

const children = [];
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('\nStarting QR Shield in development mode.');
console.log('Open the Vite URL below (not the API port) - it proxies /api for you.\n');

children.push(run('api', 'node', ['--watch', 'src/server.js'], '36'));
children.push(run('web', isWindows ? 'npx.cmd' : 'npx', ['vite'], '35'));
