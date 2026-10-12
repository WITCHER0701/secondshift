#!/usr/bin/env node
/**
 * watchdog-loop.js — persistent watchdog runner.
 * Runs dograh-watchdog.js every 5 minutes in a loop, surviving session lock
 * and sleep (it's a node process, not a cmd window). Logs to watchdog.log.
 * Put this in the Startup folder (or a scheduled task) to run at login.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const LOG = path.join(ROOT, 'watchdog.log');
const WD = path.join(ROOT, 'scripts', 'dograh-watchdog.js');
const DOCKER_BIN = 'C:\Users\Acer\AppData\Local\Programs\DockerDesktop\resources\bin';

// append a marker so we know the loop started
fs.appendFileSync(LOG, `[watchdog-loop ${new Date().toISOString()}] started (node loop)\n`);

function run() {
  const env = Object.assign({}, process.env, {
    PATH: (process.env.PATH || '') + ';' + DOCKER_BIN,
  });
  const child = spawn('node', [WD], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  child.on('close', code => {
    const ts = new Date().toISOString();
    const line = `[watchdog-loop ${ts}] watchdog.js exit ${code} (runtime ${Math.round((Date.now() - start) / 1000)}s)\n`;
    fs.appendFileSync(LOG, line);
    if (stdout) fs.appendFileSync(LOG, stdout);
    if (stderr) fs.appendFileSync(LOG, stderr);
    setTimeout(run, 300000); // 5 min
  });
  child.on('error', err => {
    fs.appendFileSync(LOG, `[watchdog-loop ${new Date().toISOString()}] watchdog.js spawn error: ${err.message}\n`);
    setTimeout(run, 300000);
  });
}
let start = Date.now();
run();
