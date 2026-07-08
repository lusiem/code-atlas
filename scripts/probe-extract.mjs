// Debug helper: extract one file and print its symbols.
// usage: node scripts/probe-extract.mjs <lang> <absFile> [filter]
import { readFileSync } from 'node:fs';
import { extractFile } from '../dist/parsing/extractor.js';
import { extractorFor } from '../dist/parsing/registry.js';

const [lang, file, filter] = process.argv.slice(2);
const source = readFileSync(file, 'utf8');
const result = await extractFile(extractorFor(lang), source);
for (const s of result.symbols) {
  if (filter && !s.name.toLowerCase().includes(filter.toLowerCase())) continue;
  console.log(`${s.startLine}: ${s.kind} ${s.name}${s.isExported ? '' : ' [private]'}`);
}
console.log(`(${result.symbols.length} symbols total)`);
