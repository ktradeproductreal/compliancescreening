import { Fragment, useEffect, useState } from 'react';
import { api, errorMessage } from '../api/client.js';

// ── Status → badge styling ────────────────────────────────────────────────────
const STATUS_STYLE = {
  success:   'bg-green-100 text-green-700',
  unchanged: 'bg-slate-100 text-slate-600',
  failed:    'bg-red-100 text-red-700',
  running:   'bg-amber-100 text-amber-800',
};

// ── Event type → badge styling (per-record events) ────────────────────────────
const EVENT_STYLE = {
  added:              'bg-green-100 text-green-700',
  reactivated:        'bg-emerald-100 text-emerald-700',
  deactivated:        'bg-orange-100 text-orange-700',
  duplicate_in_file:  'bg-amber-100 text-amber-800',
  skipped:            'bg-red-100 text-red-700',
  warning:            'bg-yellow-100 text-yellow-800',
};

function StatusBadge({ status }) {
  const cls = STATUS_STYLE[status] || 'bg-slate-100 text-slate-500';
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{status}</span>;
}

function EventBadge({ type }) {
  const cls = EVENT_STYLE[type] || 'bg-slate-100 text-slate-600';
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{type}</span>;
}

// Format sync_log.delta_json as a compact summary line.
function deltaSummary(status, delta) {
  if (!delta) return '—';
  if (status === 'unchanged' && delta.reason) return delta.reason;
  const parts = [];
  for (const k of ['added', 'kept', 'reactivated', 'updated', 'deactivated', 'duplicates_in_file', 'total_active']) {
    if (typeof delta[k] === 'number') parts.push(`${k.replace(/_/g, ' ')}: ${delta[k]}`);
  }
  return parts.join(' · ') || '—';
}

function formatDuration(started, ended) {
  if (!started || !ended) return '—';
  const ms = new Date(ended) - new Date(started);
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Expanded detail row: fetches events for one run ──────────────────────────
function LogDetail({ id }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    api.get(`/sync-logs/${id}`)
      .then(({ data }) => setDetail(data))
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="px-4 py-4 text-sm text-slate-400">Loading events…</div>;
  if (error)   return <div className="px-4 py-4 text-sm text-red-700">{error}</div>;
  if (!detail) return null;

  const events = detail.events || [];

  // Group by event_type for a quick overview count.
  const counts = events.reduce((acc, e) => {
    acc[e.event_type] = (acc[e.event_type] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="border-t border-slate-200 bg-slate-50 px-4 py-4">
      {detail.error && (
        <div className="mb-3 rounded bg-red-50 px-3 py-2 text-xs text-red-700">
          <div className="mb-1 font-semibold">Error</div>
          <pre className="whitespace-pre-wrap font-mono">{detail.error}</pre>
        </div>
      )}

      {events.length === 0 ? (
        <div className="text-sm text-slate-500">
          No per-record events recorded for this run. Only changes and drops are logged, so an
          &ldquo;unchanged&rdquo; run legitimately has zero events.
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-2 text-xs text-slate-600">
            <span className="font-medium text-slate-700">{events.length} event(s):</span>
            {Object.entries(counts).map(([type, n]) => (
              <span key={type} className="rounded bg-white px-2 py-0.5 shadow-sm">
                {type}: <span className="font-semibold">{n}</span>
              </span>
            ))}
          </div>

          <div className="overflow-x-auto rounded border border-slate-200 bg-white">
            <table className="min-w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-100 uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Row</th>
                  <th className="px-3 py-2">Ref / CNIC</th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {events.map((e) => (
                  <tr key={e.id} className="align-top">
                    <td className="px-3 py-2"><EventBadge type={e.event_type} /></td>
                    <td className="px-3 py-2 font-mono text-slate-500">{e.row_number ?? '—'}</td>
                    <td className="px-3 py-2 font-mono text-slate-600">
                      {e.ref_code || (e.cnic ? e.cnic.replace(/-/g, '') : '—')}
                    </td>
                    <td className="px-3 py-2 text-slate-800">
                      {e.full_name || '—'}
                      {e.father_name && (
                        <div className="text-slate-500">s/o {e.father_name}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-600">{e.detail || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export default function SyncLogs() {
  const [data, setData] = useState({ rows: [], total: 0, page: 1, pageSize: 20 });
  const [page, setPage] = useState(1);
  const [source, setSource] = useState('');
  const [status, setStatus] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Reset to page 1 when filters change.
  useEffect(() => { setPage(1); }, [source, status]);

  useEffect(() => {
    setLoading(true);
    const params = { page, pageSize: 20 };
    if (source) params.source = source;
    if (status) params.status = status;
    api.get('/sync-logs', { params })
      .then(({ data }) => setData(data))
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  }, [page, source, status]);

  const totalPages = Math.max(Math.ceil(data.total / data.pageSize), 1);

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold text-slate-800">Sync Logs</h1>
      <p className="mb-6 text-sm text-slate-500">
        Per-run audit trail of the cron auto-syncs (NACTA every 3h, UNSC daily). Click a row to
        see which records were added, deactivated, duplicated, or dropped — and why.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          <option value="">All sources</option>
          <option value="nacta">NACTA</option>
          <option value="unsc">UNSC</option>
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          <option value="">All statuses</option>
          <option value="success">success</option>
          <option value="unchanged">unchanged</option>
          <option value="failed">failed</option>
          <option value="running">running</option>
        </select>
      </div>

      {error && <div className="mb-4 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="overflow-x-auto rounded-lg bg-white shadow">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Started</th>
              <th className="px-4 py-3">Duration</th>
              <th className="px-4 py-3">Trigger</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Delta</th>
              <th className="px-4 py-3">Events</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">Loading…</td></tr>
            ) : data.rows.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">
                No sync runs recorded yet.
              </td></tr>
            ) : (
              data.rows.map((r) => {
                const isOpen = expandedId === r.id;
                return (
                  <Fragment key={r.id}>
                    <tr
                      className="cursor-pointer hover:bg-slate-50"
                      onClick={() => setExpandedId(isOpen ? null : r.id)}
                    >
                      <td className="px-4 py-3 font-medium uppercase text-slate-700">{r.source}</td>
                      <td className="px-4 py-3 text-slate-600">{new Date(r.started_at).toLocaleString()}</td>
                      <td className="px-4 py-3 font-mono text-slate-500">
                        {formatDuration(r.started_at, r.ended_at)}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{r.triggered_by}</td>
                      <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                      <td className="px-4 py-3 text-xs text-slate-600">
                        {deltaSummary(r.status, r.delta_json)}
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-500">{r.event_count}</td>
                      <td className="px-4 py-3 text-right text-brand-700">
                        {isOpen ? '▲' : '▼'}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={8} className="p-0">
                          <LogDetail id={r.id} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
        <span>{data.total} run(s)</span>
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
