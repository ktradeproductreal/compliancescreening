import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../api/client.js';

function ListCard({ title, data }) {
  const active = !!data;
  return (
    <div className="rounded-lg bg-white p-6 shadow">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-800">{title}</h2>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            active ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'
          }`}
        >
          {active ? 'Active' : 'Not Uploaded'}
        </span>
      </div>
      {active ? (
        <dl className="space-y-1 text-sm text-slate-600">
          <div className="flex justify-between">
            <dt>Version</dt>
            <dd className="font-medium text-slate-800">{data.version_label}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Records</dt>
            <dd className="font-medium text-slate-800">{data.record_count?.toLocaleString()}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Uploaded</dt>
            <dd className="font-medium text-slate-800">
              {new Date(data.uploaded_at).toLocaleString()}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="text-sm text-slate-500">No list has been uploaded yet.</p>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get('/upload/status')
      .then(({ data }) => setStatus(data))
      .catch((err) => setError(errorMessage(err)));
  }, []);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-slate-800">Dashboard</h1>

      {error && <div className="mb-4 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="mb-8 grid gap-6 sm:grid-cols-2">
        <ListCard title="NACTA List" data={status?.nacta} />
        <ListCard title="UNSC List" data={status?.unsc} />
      </div>

      <div className="flex flex-wrap gap-3">
        <Link to="/upload" className="rounded bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
          Upload Lists
        </Link>
        <Link to="/screen" className="rounded bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
          Run Screening
        </Link>
        <Link to="/history" className="rounded border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
          View History
        </Link>
      </div>
    </div>
  );
}
