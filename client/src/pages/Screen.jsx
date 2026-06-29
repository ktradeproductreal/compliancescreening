import { useState } from 'react';
import { api, errorMessage } from '../api/client.js';

// ── CNIC formatting (PRD §7.4): user types 13 digits, dashes auto-inserted ────
function formatCnicInput(value) {
  const digits = value.replace(/\D/g, '').slice(0, 13);
  const parts = [digits.slice(0, 5), digits.slice(5, 12), digits.slice(12, 13)].filter(Boolean);
  return parts.join('-');
}
const cnicDigits = (value) => value.replace(/\D/g, '');

// ── DOB validation: dd-MMM-yyyy (e.g. 10-JAN-2030) ──────────────────────────
const DOB_REGEX = /^\d{1,2}-(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)-\d{4}$/i;
const isDobValid = (v) => DOB_REGEX.test(v.trim());

// ── Result classification → badge styling ─────────────────────────────────────
const HIT = { CNIC_MATCH_NAME_CONFIRMED: 1, CONFIRMED_MATCH: 1 };
const REVIEW = { CNIC_MATCH_NAME_UNCONFIRMED: 1, NAME_ONLY_MATCH: 1, POSSIBLE_MATCH: 1 };

function badge(result) {
  const type = result?.match_type;
  if (HIT[type]) return { text: '🔴 Record Found', cls: 'bg-red-100 text-red-700' };
  if (REVIEW[type]) return { text: '🟡 Possible Match — Manual Review', cls: 'bg-amber-100 text-amber-800' };
  if (type === 'NO_LIST_UPLOADED') return { text: '⚪ No List Uploaded', cls: 'bg-slate-100 text-slate-500' };
  return { text: '🟢 No Record Found', cls: 'bg-green-100 text-green-700' };
}

function ResultSection({ title, result }) {
  const b = badge(result);
  return (
    <div className="rounded-lg bg-white p-5 shadow">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold text-slate-800">{title}</h3>
        <span className={`rounded-full px-3 py-1 text-sm font-medium ${b.cls}`}>{b.text}</span>
      </div>
      {result?.records?.length > 0 && (
        <ul className="space-y-2 text-sm text-slate-600">
          {result.records.map((r, i) => (
            <li key={i} className="rounded border border-slate-200 p-2">
              {r.primary_name ? (
                <>
                  <div><span className="font-medium">{r.ref_code}</span> — {r.primary_name}</div>
                  {r.aliases?.length > 0 && <div className="text-xs">Aliases: {r.aliases.join('; ')}</div>}
                  {r.nationality && <div className="text-xs">Nationality: {r.nationality}</div>}
                  {r.pakistan_link && <div className="text-xs text-amber-700">{r.pakistan_link}</div>}
                  {typeof r.match_score === 'number' && (
                    <div className="text-xs">Score: {Math.round(r.match_score * 100)}%</div>
                  )}
                </>
              ) : (
                <>
                  <div className="font-medium">{r.full_name}</div>
                  <div className="text-xs">Father: {r.father_name} · CNIC: {r.cnic}</div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Screen() {
  const [cnic, setCnic] = useState('');
  const [fullName, setFullName] = useState('');
  const [fatherName, setFatherName] = useState('');
  const [dob, setDob] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [pdfBusy, setPdfBusy] = useState(false);

  const cnicValid = cnicDigits(cnic).length === 13;
  const dobValid = isDobValid(dob);
  const canSubmit = cnicValid && fullName.trim().length >= 2 && dobValid && !busy;

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const { data } = await api.post('/screening/run', {
        cnic,
        full_name: fullName.trim(),
        father_name: fatherName.trim(),
        dob: dob.trim().toUpperCase(),
      });
      setResult(data);
    } catch (err) {
      setError(errorMessage(err, 'Screening failed.'));
    } finally {
      setBusy(false);
    }
  }

  // PDF route is auth-protected, so fetch it as a blob (token attached by axios)
  // and open the object URL — a plain window.open would omit the Authorization header.
  async function openPdf() {
    if (!result?.id) return;
    setPdfBusy(true);
    try {
      const { data } = await api.get(`/screening/${result.id}/pdf`, { responseType: 'blob' });
      const url = URL.createObjectURL(data);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError(errorMessage(err, 'Could not open the PDF report.'));
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-slate-800">Run Screening</h1>

      <form onSubmit={handleSubmit} className="mb-8 max-w-lg rounded-lg bg-white p-6 shadow">
        <label className="mb-4 block">
          <span className="mb-1 block text-sm font-medium text-slate-600">CNIC</span>
          <input
            inputMode="numeric"
            placeholder="XXXXX-XXXXXXX-X"
            value={cnic}
            onChange={(e) => setCnic(formatCnicInput(e.target.value))}
            className="w-full rounded border border-slate-300 px-3 py-2 font-mono focus:border-brand-600 focus:outline-none"
          />
          {cnic && !cnicValid && (
            <span className="mt-1 block text-xs text-red-600">CNIC must be 13 digits.</span>
          )}
        </label>

        <label className="mb-4 block">
          <span className="mb-1 block text-sm font-medium text-slate-600">Full Name</span>
          <input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="w-full rounded border border-slate-300 px-3 py-2 focus:border-brand-600 focus:outline-none"
          />
        </label>

        <label className="mb-4 block">
          <span className="mb-1 block text-sm font-medium text-slate-600">
            Father&apos;s Name <span className="text-slate-400">(optional)</span>
          </span>
          <input
            value={fatherName}
            onChange={(e) => setFatherName(e.target.value)}
            className="w-full rounded border border-slate-300 px-3 py-2 focus:border-brand-600 focus:outline-none"
          />
        </label>

        <label className="mb-6 block">
          <span className="mb-1 block text-sm font-medium text-slate-600">
            Date of Birth <span className="text-slate-400">(required for UNSC match)</span>
          </span>
          <input
            placeholder="10-JAN-2030"
            value={dob}
            onChange={(e) => setDob(e.target.value.toUpperCase())}
            className="w-full rounded border border-slate-300 px-3 py-2 font-mono uppercase focus:border-brand-600 focus:outline-none"
          />
          {dob && !dobValid && (
            <span className="mt-1 block text-xs text-red-600">
              Format must be dd-MMM-yyyy (e.g. 10-JAN-2030).
            </span>
          )}
        </label>

        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded bg-brand-600 px-5 py-2 font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {busy ? 'Screening…' : 'Run Screening'}
        </button>
      </form>

      {error && <div className="mb-4 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {result && (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <ResultSection title="NACTA Proscribed Persons List" result={result.nacta} />
            <ResultSection title="UNSC Consolidated List" result={result.unsc} />
          </div>
          <button
            onClick={openPdf}
            disabled={pdfBusy}
            className="rounded border border-brand-600 px-4 py-2 text-sm font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-60"
          >
            {pdfBusy ? 'Preparing PDF…' : 'Download PDF Report'}
          </button>
        </div>
      )}
    </div>
  );
}
