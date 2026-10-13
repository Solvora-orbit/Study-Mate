#!/usr/bin/env node
// zcode/VERSION 补丁位递增：node zcode/scripts/bump-version.mjs
import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve(import.meta.dirname, '..', 'VERSION');
const current = fs.readFileSync(file, 'utf8').trim();
const parts = current.split('.');
if (parts.length !== 3 || parts.some(p => !/^\d+$/.test(p))) {
  console.error(`VERSION 不是 x.y.z：${current}`);
  process.exit(1);
}
parts[2] = String(Number(parts[2]) + 1);
const next = parts.join('.');
fs.writeFileSync(file, `${next}\n`);
console.log(next);
