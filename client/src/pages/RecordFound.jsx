import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../api/client.js';

const HIT = { CNIC_MATCH_NAME_CONFIRMED: 1, CONFIRMED_MATCH: 1 };
const REVIEW = { CNIC_MATCH_NAME_UNCONFIRMED: 1, NAME_ONLY_MATCH: 1, POSSIBLE_MATCH: 1 };

function ResultBadge({ matchType }) {
  let cls = 'bg-green-100 text-green-700';
  let text = 'No Record';
  if (HIT[matchType]) {
    cls = 'bg-red-100 text-red-700';
    text = 'Record Found';
  } else if (REVIEW[matchType]) {
    cls = 'bg-amber-100 text-amber-800';
    text = 'Possible Match';
  } else if (matchType === 'NO_LIST_UPLOADED') {
    cls = 'bg-slate-100 text-slate-500';
    text = 'No List';
  }
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{text}</span>;
}

export default function RecordFound() {
  const [data, setData] = useState({ rows: [], total: 0, page: 1, pageSize: 20 });
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [pdfId, setPdfId] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch]);

  useEffect(() => {
    setLoading(true);
    const params = { page, pageSize: 20, filter: 'hits' };
    if (debouncedSearch) params.q = debouncedSearch;
    api
      .get('/screening/history', { params })
      .then(({ data }) => setData(data))
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  }, [page, debouncedSearch]);

  const openPdf = useCallback(async (id) => {
    setPdfId(id);
    try {
      const { data } = await api.get(`/screening/${id}/pdf`, { responseType: 'blob' });
      const url = URL.createObjectURL(data);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError(errorMessage(err, 'Could not open the PDF report.'));
    } finally {
      setPdfId(null);
    }
  }, []);

  const totalPages = Math.max(Math.ceil(data.total / data.pageSize), 1);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-slate-800">Record Found</h1>

      <div className="mb-4 flex items-center gap-2">
        <div className="relative flex-1 max-w-md">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by CNIC (with or without dashes) or subject name…"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 pr-8 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {error && <div className="mb-4 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="overflow-x-auto rounded-lg bg-white shadow">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">Ref #</th>
              <th className="px-4 py-3">Subject Name</th>
              <th className="px-4 py-3">CNIC</th>
              <th className="px-4 py-3">Date/Time</th>
              <th className="px-4 py-3">NACTA</th>
              <th className="px-4 py-3">UNSC</th>
              <th className="px-4 py-3">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">Loading…</td></tr>
            ) : data.rows.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                {debouncedSearch
                  ? `No records found matching "${debouncedSearch}".`
                  : 'No confirmed or possible matches yet.'}
              </td></tr>
            ) : (
              data.rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-mono text-slate-500">SCR-{String(r.id).padStart(6, '0')}</td>
                  <td className="px-4 py-3 font-medium text-slate-800">{r.full_name}</td>
                  <td className="px-4 py-3 font-mono text-slate-600">{(r.cnic || '').replace(/-/g, '')}</td>
                  <td className="px-4 py-3 text-slate-600">{new Date(r.screened_at).toLocaleString()}</td>
                  <td className="px-4 py-3"><ResultBadge matchType={r.nacta_match_type} /></td>
                  <td className="px-4 py-3"><ResultBadge matchType={r.unsc_match_type} /></td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => openPdf(r.id)}
                      disabled={pdfId === r.id}
                      className="text-brand-700 hover:underline disabled:opacity-60"
                    >
                      {pdfId === r.id ? 'Opening…' : 'View Report'}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
        <span>{data.total} match(es)</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(p - 1, 1))}
            disabled={page <= 1}
            className="rounded border border-slate-300 px-3 py-1 disabled:opacity-50"
          >
            Previous
          </button>
          <span>Page {data.page} of {totalPages}</span>
          <button
            onClick={() => setPage((p) => Math.min(p + 1, totalPages))}
            disabled={page >= totalPages}
            className="rounded border border-slate-300 px-3 py-1 disabled:opacity-50"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
