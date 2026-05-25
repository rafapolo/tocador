#!/usr/bin/env node
/**
 * extract-genres.js — JS wrapper for extract-genres.py
 * Requires: pip3 install essentia-tensorflow
 *
 * Usage:
 *   node script/extract-genres.js                  # process all unclassified albums
 *   node script/extract-genres.js --random 3       # test on N random albums
 *   node script/extract-genres.js --albums "2012 - X" "2013 - Y"
 */

'use strict';
const { spawn } = require('child_process');
const path      = require('path');

const py = path.join(__dirname, 'extract-genres.py');

const child = spawn('python3', [py, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', code => process.exit(code ?? 0));
