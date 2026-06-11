// Dev helper: generate a sample NACTA Excel file into ../samples/.
// Run from the server dir so `xlsx` resolves:  node make-nacta-xlsx.mjs
// Exercises Q13 tolerance: leading unnamed index column + extra PROVINCE/DISTRICT
// columns, and CNICs stored as plain 13 digits without dashes.
import XLSX from 'xlsx';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Headers match the real NACTA file: Name / Father / CNIC / Province / District
// (no leading index column). Province/District are ignored by the parser.
const rows = [
  ['Name', 'Father', 'CNIC', 'Province', 'District'],
  ['MUHAMMAD ALI', 'GHULAM HASSAN', '4210112345671', 'SINDH', 'KARACHI'],
  ['AHMED KHAN', 'BASHIR KHAN', '3520298765432', 'PUNJAB', 'LAHORE'],
  ['FATIMA BIBI', 'ABDUL REHMAN', '1730155544433', 'KP', 'PESHAWAR'],
  ['BAD ROW NO CNIC', 'SOMEONE', '123', 'PUNJAB', 'MULTAN'], // skipped: CNIC not 13 digits
];

const ws = XLSX.utils.aoa_to_sheet(rows);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'NACTA');

const outDir = path.resolve(__dirname, '../samples');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'nacta-sample.xlsx');
XLSX.writeFile(wb, out);
console.log('Wrote', out);
