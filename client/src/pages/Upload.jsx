import { useState } from 'react';
import { api, errorMessage } from '../api/client.js';

function UploadZone({ title, endpoint, accept, hint }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  async function handleUpload() {
    if (!file) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const { data } = await api.post(endpoint, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setResult(data);
    } catch (err) {
      setError(errorMessage(err, 'Upload failed.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg bg-white p-6 shadow">
      <h2 className="mb-1 text-lg font-semibold text-slate-800">{title}</h2>
      <p className="mb-4 text-sm text-slate-500">{hint}</p>

      <input
        type="file"
        accept={accept}
        onChange={(e) => {
          setFile(e.target.files?.[0] || null);
          setResult(null);
          setError('');
        }}
        className="mb-4 block w-full text-sm text-slate-600 file:mr-3 file:rounded file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-brand-700"
      />

      <button
        onClick={handleUpload}
        disabled={!file || busy}
        className="rounded bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
      >
        {busy ? 'Uploading…' : 'Upload'}
      </button>

      {error && <div className="mt-4 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {result && (
        <div className="mt-4 rounded border border-green-200 bg-green-50 px-3 py-3 text-sm text-green-800">
          <p className="font-medium">
            Uploaded as {result.version_label} — {result.record_count?.toLocaleString()} records parsed.
          </p>
          {typeof result.skipped === 'number' && result.skipped > 0 && (
            <p className="mt-1">{result.skipped} row(s) skipped.</p>
          )}
          {typeof result.parse_errors === 'number' && result.parse_errors > 0 && (
            <p className="mt-1">{result.parse_errors} entry parse error(s).</p>
          )}
          {result.warnings?.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer">{result.warnings.length} warning(s)</summary>
              <ul className="mt-1 list-disc pl-5 text-xs text-green-700">
                {result.warnings.slice(0, 50).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export default function Upload() {
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-slate-800">Upload Lists</h1>
      <div className="grid gap-6 md:grid-cols-2">
        <UploadZone
          title="NACTA List"
          endpoint="/upload/nacta"
          accept=".xlsx,.xls"
          hint="Excel file with NAME, FATHER NAME and CNIC columns (.xlsx / .xls)."
        />
        <UploadZone
          title="UNSC List"
          endpoint="/upload/unsc"
          accept=".html,.htm"
          hint="UNSC Consolidated List HTML export (.html / .htm)."
        />
      </div>
    </div>
  );
}
