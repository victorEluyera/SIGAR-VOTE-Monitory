import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../api/client.js';
import { getRegistrationLocationOptions } from '../../../shared/electionData.js';
import './resource-intelligence.css';

const RESOURCE_TYPES = ['Radio', 'Vehicle', 'Ballot Materials', 'Fuel', 'Generator', 'Mobile Device', 'Personnel Support'];
const UTILIZATION_STATUSES = ['adequate', 'underutilized', 'overstretched'];

function scopeQuery(scope) {
  const params = new URLSearchParams();
  if (scope.lga) params.set('lga', scope.lga);
  if (scope.ward) params.set('ward', scope.ward);
  const query = params.toString();
  return query ? `?${query}` : '';
}

function DeploymentRow({ deployment, authToken, onDone }) {
  const [open, setOpen] = useState('');
  const [arrivalQty, setArrivalQty] = useState('');
  const [reallocateLga, setReallocateLga] = useState('');
  const [reallocateReason, setReallocateReason] = useState('');
  const [returnQty, setReturnQty] = useState('');
  const [returnReason, setReturnReason] = useState('');
  const [utilizationStatus, setUtilizationStatus] = useState('adequate');
  const [usedQuantity, setUsedQuantity] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (path, body) => {
    setBusy(true); setError('');
    try {
      await apiRequest(`/area-operations/resources/${deployment.id}/${path}`, authToken, { method: 'POST', body: JSON.stringify(body) });
      setOpen('');
      onDone();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const remaining = Math.max(0, Number(deployment.originalQuantity ?? deployment.quantity ?? 0) - Number(deployment.arrivedQuantity || 0));

  return (
    <article className="ri-deployment">
      <div className="ri-deployment-summary">
        <div>
          <b>{deployment.resourceType}</b>
          <span>{deployment.originalQuantity ?? deployment.quantity} {deployment.unit || 'units'} · {[deployment.geography?.lga, deployment.geography?.ward].filter(Boolean).join(' · ') || 'Oyo State'}</span>
        </div>
        <div className="ri-badges">
          <span className={`ri-badge ri-arrival-${deployment.arrivalStatus}`}>{deployment.arrivalStatus}</span>
          <span className={`ri-badge ri-utilization-${deployment.utilizationStatus}`}>{deployment.utilizationStatus}</span>
        </div>
      </div>
      <div className="ri-deployment-actions">
        {remaining > 0 && <button onClick={() => setOpen(open === 'arrival' ? '' : 'arrival')}>Confirm arrival</button>}
        <button onClick={() => setOpen(open === 'reallocate' ? '' : 'reallocate')}>Reallocate</button>
        <button onClick={() => setOpen(open === 'return' ? '' : 'return')}>Return</button>
        <button onClick={() => setOpen(open === 'utilization' ? '' : 'utilization')}>Review utilization</button>
      </div>
      {open === 'arrival' && (
        <div className="ri-inline-form">
          <label>Quantity arrived (remaining {remaining})<input type="number" min="1" max={remaining} value={arrivalQty} onChange={(e) => setArrivalQty(e.target.value)} /></label>
          <button className="primary" disabled={busy || !arrivalQty} onClick={() => run('arrival', { quantity: Number(arrivalQty) })}>Confirm</button>
        </div>
      )}
      {open === 'reallocate' && (
        <div className="ri-inline-form">
          <label>New LGA<input value={reallocateLga} onChange={(e) => setReallocateLga(e.target.value)} placeholder="e.g. ATIBA" /></label>
          <label>Reason<input value={reallocateReason} onChange={(e) => setReallocateReason(e.target.value)} /></label>
          <button className="primary" disabled={busy || !reallocateLga || !reallocateReason} onClick={() => run('reallocate', { geography: { ...deployment.geography, lga: reallocateLga, ward: '' }, reason: reallocateReason })}>Reallocate</button>
        </div>
      )}
      {open === 'return' && (
        <div className="ri-inline-form">
          <label>Quantity returned<input type="number" min="1" value={returnQty} onChange={(e) => setReturnQty(e.target.value)} /></label>
          <label>Reason<input value={returnReason} onChange={(e) => setReturnReason(e.target.value)} /></label>
          <button className="primary" disabled={busy || !returnQty || !returnReason} onClick={() => run('return', { quantity: Number(returnQty), reason: returnReason })}>Return</button>
        </div>
      )}
      {open === 'utilization' && (
        <div className="ri-inline-form">
          <label>Status
            <select value={utilizationStatus} onChange={(e) => setUtilizationStatus(e.target.value)}>
              {UTILIZATION_STATUSES.map((status) => <option key={status}>{status}</option>)}
            </select>
          </label>
          <label>Used quantity<input type="number" min="0" value={usedQuantity} onChange={(e) => setUsedQuantity(e.target.value)} /></label>
          <button className="primary" disabled={busy} onClick={() => run('utilization', { utilizationStatus, usedQuantity: Number(usedQuantity || 0) })}>Save review</button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </article>
  );
}

/** `lga`, when given, comes from the page's own LGA filter (the Resources tab) and hides this one. */
export default function ResourceIntelligence({ authToken, lga: pageLga, onChanged }) {
  const [scope, setScope] = useState({ lga: pageLga || '', ward: '' });
  useEffect(() => { if (pageLga !== undefined) setScope({ lga: pageLga, ward: '' }); }, [pageLga]);
  const [form, setForm] = useState({ action: 'requirement', resourceType: 'Radio', quantity: '', unit: 'units', reservedFor: '', reason: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const client = useQueryClient();
  const options = getRegistrationLocationOptions('Oyo', scope.lga);

  const key = ['resource-dashboard', authToken, scope.lga, scope.ward];
  const dashboard = useQuery({ queryKey: key, queryFn: ({ signal }) => apiRequest(`/area-operations/resources/dashboard${scopeQuery(scope)}`, authToken, { signal }) });
  const recordsKey = ['resource-records', authToken, scope.lga, scope.ward];
  const records = useQuery({ queryKey: recordsKey, queryFn: ({ signal }) => apiRequest(`/area-operations/resources/records${scopeQuery(scope)}`, authToken, { signal }) });

  const refresh = () => { client.invalidateQueries({ queryKey: key }); client.invalidateQueries({ queryKey: recordsKey }); onChanged?.(); };

  const changeScope = (event) => setScope((previous) => ({ ...previous, [event.target.name]: event.target.value, ...(event.target.name === 'lga' ? { ward: '' } : {}) }));
  const changeForm = (event) => setForm((previous) => ({ ...previous, [event.target.name]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true); setError('');
    const geography = { state: 'Oyo', lga: scope.lga, ward: scope.ward };
    const paths = { requirement: 'requirements', availability: 'availability', dispatch: 'dispatch', reservation: 'reservations' };
    const bodies = {
      requirement: { resourceType: form.resourceType, quantity: Number(form.quantity), unit: form.unit, geography, forecastDate: new Date().toISOString().slice(0, 10), basis: form.reason },
      availability: { resourceType: form.resourceType, quantity: Number(form.quantity), unit: form.unit, geography },
      dispatch: { resourceType: form.resourceType, quantity: Number(form.quantity), unit: form.unit, geography, sourceGeography: geography },
      reservation: { resourceType: form.resourceType, quantity: Number(form.quantity), geography, reservedFor: form.reason },
    };
    try {
      if (!scope.lga) throw new Error('Select an LGA before recording a resource action.');
      await apiRequest(`/area-operations/resources/${paths[form.action]}`, authToken, { method: 'POST', body: JSON.stringify(bodies[form.action]) });
      setForm((previous) => ({ ...previous, quantity: '', reason: '' }));
      refresh();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <section className="ri-panel">
      <header><span className="eyebrow">RESOURCE INTELLIGENCE</span><p>Requirement → allocation → deployment → adequacy, tracked by geography.</p></header>

      <div className="area-operation-form ri-scope">
        {pageLga === undefined && <label>Local government<select name="lga" value={scope.lga} onChange={changeScope}><option value="">All of Oyo State</option>{getRegistrationLocationOptions('Oyo').lgas.map((name) => <option key={name}>{name}</option>)}</select></label>}
        <label>Ward<select name="ward" value={scope.ward} onChange={changeScope} disabled={!scope.lga}><option value="">All wards</option>{options.wards.map((name) => <option key={name}>{name}</option>)}</select></label>
      </div>

      {dashboard.isPending && <p role="status">Loading resource adequacy…</p>}
      {dashboard.isError && <p role="alert">{dashboard.error.message} <button onClick={() => dashboard.refetch()}>Retry</button></p>}
      {dashboard.data && (
        <div className="ri-adequacy">
          {!dashboard.data.resources.length && <p className="area-note">No resource activity recorded for this geography yet.</p>}
          {dashboard.data.resources.map((row, index) => (
            <div key={index} className={`ri-adequacy-row ${row.missing > 0 ? 'ri-short' : ''}`}>
              <b>{row.resourceType}</b>
              <span>Required {row.required}</span>
              <span>Available {row.available}</span>
              <span>Deployed {row.deployed}</span>
              <span>Arrived {row.arrived}</span>
              <span className="ri-missing">Missing {row.missing}</span>
            </div>
          ))}
        </div>
      )}

      <form className="area-operation-form ri-record-form" onSubmit={submit}>
        <label>Action
          <select name="action" value={form.action} onChange={changeForm}>
            <option value="requirement">Record requirement</option>
            <option value="availability">Record availability</option>
            <option value="dispatch">Dispatch</option>
            <option value="reservation">Reserve</option>
          </select>
        </label>
        <label>Resource type
          <select name="resourceType" value={form.resourceType} onChange={changeForm}>
            {RESOURCE_TYPES.map((type) => <option key={type}>{type}</option>)}
          </select>
        </label>
        <label>Quantity<input type="number" min="1" name="quantity" value={form.quantity} onChange={changeForm} required /></label>
        <label>Unit<input name="unit" value={form.unit} onChange={changeForm} /></label>
        {form.action === 'reservation' && <label className="area-form-wide">Reserved for<input name="reason" value={form.reason} onChange={changeForm} placeholder="e.g. Election-day surge" /></label>}
        {form.action === 'requirement' && <label className="area-form-wide">Basis<input name="reason" value={form.reason} onChange={changeForm} placeholder="e.g. 1 radio per polling unit" /></label>}
        <button className="primary" disabled={busy}>{busy ? 'Saving…' : `Save ${form.action}`}</button>
      </form>
      {error && <p role="alert">{error}</p>}

      <h3>Deployments</h3>
      {records.isPending && <p role="status">Loading deployments…</p>}
      {records.data && !records.data.deployment.length && <p className="area-note">No dispatches recorded for this geography.</p>}
      <div className="ri-deployment-list">
        {records.data?.deployment.map((deployment) => (
          <DeploymentRow key={deployment.id} deployment={deployment} authToken={authToken} onDone={refresh} />
        ))}
      </div>
    </section>
  );
}
