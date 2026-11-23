#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { validateEndpointSlices } from '../src/validator.js';

async function readInput(path) {
  if (!path || path === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }
  return readFile(path, 'utf8');
}

const path = process.argv[2];
try {
  const raw = await readInput(path);
  const input = JSON.parse(raw);
  const report = validateEndpointSlices(input);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.unsafeRoutes.length > 0 || report.conflictingSlices.length > 0 ? 1 : 0;
} catch (error) {
  process.stderr.write(`validation failed: ${error.message}\n`);
  process.exitCode = 2;
}
