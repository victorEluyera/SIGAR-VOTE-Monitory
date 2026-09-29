import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { apiRequest } from "../../api/client.js";
import { getRegistrationLocationOptions } from "../../../shared/electionData.js";
import { lgaKey } from "../stakeholder/ui.jsx";
import ReportingLifecycle from "./ReportingLifecycle.jsx";
import ResourceIntelligence from "./ResourceIntelligence.jsx";
import { buildReport, downloadExcel, downloadPowerPoint, printReport, recommendResources } from "./resourceReport.js";
import { useFitHeight } from "./useFitHeight.js";
import "./pre-election-views.css";
import "./area-analysis.css"; // resource tracking forms
import "./resources-tab.css";

/**
 * Resources: campaign planning, resource tracking and reports in one tab.
 *
 *   Plans     -- what to act on (critical intelligence), what the campaign needs for its size
 *                (recommended resources) and the operations planned.
 *   Resources -- requirement -> allocation -> deployment -> arrival, by LGA and ward.
 *   Reports   -- a campaign report as PDF, Excel or PowerPoint, previewed first.
 */

const VIEWS = [
  { id: "plans", label: "Plans", title: "Campaign planning" },
  { id: "resources", label: "Resources", title: "Resource intelligence" },
  { id: "reports", label: "Reports", title: "Report generation" },
];
const PLAN_TYPES = ["Campaign", "Logistics", "Training", "Observer coverage", "Accessibility"];
const num = (value) => (value == null ? "—" : Number(value).toLocaleString());
const titleCase = (value) => String(value || "").toLowerCase().replace(/(^|[\s/(-])([a-z])/g, (match, lead, char) => lead + char.toUpperCase());

function PlanForm({ authToken, lga, onSaved }) {
  const blank = { title: "", category: "Campaign", lga: lga || "", ward: "", date: "", notes: "" };
  const [form, setForm] = useState(blank);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const options = getRegistrationLocationOptions("Oyo", form.lga);
  const change = (event) => setForm((current) => ({ ...current, [event.target.name]: event.target.value, ...(event.target.name === "lga" ? { ward: "" } : {}) }));
  const save = async (event) => {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await apiRequest("/area-operations/plans", authToken, { method: "POST", body: JSON.stringify(form) });
      setForm(blank);
      onSaved();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  return (
    <form className="rs-form" onSubmit={save}>
      <label className="rs-wide">Plan<input required maxLength={120} name="title" value={form.title} onChange={change} placeholder="Ward rally in Oja Oba" /></label>
      <label>Type<select name="category" value={form.category} onChange={change}>{PLAN_TYPES.map((type) => <option key={type}>{type}</option>)}</select></label>
      <label>Date<input required type="date" name="date" value={form.date} onChange={change} /></label>
      <label>LGA<select required name="lga" value={form.lga} onChange={change}><option value="">Choose</option>{getRegistrationLocationOptions("Oyo").lgas.map((name) => <option key={name} value={name}>{titleCase(name)}</option>)}</select></label>
      <label>Ward<select name="ward" value={form.ward} onChange={change} disabled={!form.lga}><option value="">All wards</option>{options.wards.map((name) => <option key={name} value={name}>{titleCase(name)}</option>)}</select></label>
      <label className="rs-wide">Notes<textarea name="notes" rows={2} maxLength={2000} value={form.notes} onChange={change} placeholder="Venue, people, vehicles, materials" /></label>
      {error && <p className="rs-error rs-wide" role="alert">{error}</p>}
      <button type="submit" className="rs-primary rs-wide" disabled={busy}>{busy ? "Saving…" : "Save plan"}</button>
    </form>
  );
}

function PlansView({ authToken, lga, plans, critical, needs, recorded, onPlansChanged }) {
  const [adding, setAdding] = useState(false);
  const client = useQueryClient();
  const remove = async (id) => {
    await apiRequest(`/area-operations/plans/${id}`, authToken, { method: "DELETE" }).catch(() => {});
    client.invalidateQueries({ queryKey: ["resources-plans"] });
  };
  return (
    <div className="rs-plans">
      <section className="pv-card rs-critical">
        <header><h3>Critical intelligence</h3><p>From the call center, 10x and online</p></header>
        {critical ? (
          <ol>{critical.slice(0, 6).map((item) => <li key={item.text} className={item.tone}><span className="fb-src">{item.source}</span><p>{item.text}</p></li>)}</ol>
        ) : <p className="pv-note">Loading…</p>}
      </section>

      <section className="pv-card">
        <header><h3>Resource allocation</h3><p>Recommended resources for {lga ? titleCase(lga) : "the whole state"}, from its wards, polling units and voters</p></header>
        {needs ? (
          <div className="rs-table-wrap">
            <table className="rs-table">
              <thead><tr><th>#</th><th>Resource</th><th className="num">Recommended</th><th className="num">Recorded</th><th>Basis</th></tr></thead>
              {needs.map((group, index) => (
                <tbody key={group.module}>
                  <tr className="rs-module"><th colSpan={5}>{index + 1}. {group.module}</th></tr>
                  {group.rows.map((row) => (
                    <tr key={row.name}>
                      <td />
                      <td>{row.name}</td>
                      <td className="num"><b>{num(row.value)}</b></td>
                      <td className="num">{row.recorded ? num(recorded.get(row.recorded)) : ""}</td>
                      <td className="rs-basis">{row.basis}</td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        ) : <p className="pv-note">Loading…</p>}
      </section>

      <section className="pv-card rs-list">
        <header className="rs-list-head">
          <div><h3>Plans</h3><p>{plans.length} planned{lga ? ` in ${titleCase(lga)}` : ""}</p></div>
          <button type="button" className="rs-primary" onClick={() => setAdding((value) => !value)}>{adding ? "Close" : "New plan"}</button>
        </header>
        {adding && <PlanForm authToken={authToken} lga={lga} onSaved={() => { setAdding(false); onPlansChanged(); }} />}
        {plans.length ? (
          <ul>
            {plans.map((plan) => (
              <li key={plan.id}>
                <time>{plan.date}</time>
                <div><b>{plan.title}</b><small>{plan.category} · {titleCase(plan.lga)}{plan.ward ? ` · ${titleCase(plan.ward)}` : ""}</small>{plan.notes && <p>{plan.notes}</p>}</div>
                <button type="button" className="rs-link" onClick={() => remove(plan.id)} aria-label={`Remove ${plan.title}`}>Remove</button>
              </li>
            ))}
          </ul>
        ) : !adding && <p className="pv-note">No plans for this area and date yet. Use New plan to add one.</p>}
      </section>
    </div>
  );
}

function ReportsView({ authToken, report, form, setForm }) {
  const [status, setStatus] = useState("");
  const run = async (label, action) => {
    setStatus(`Creating the ${label}…`);
    try { await action(report); setStatus(`${label} created.`); } catch (failure) { setStatus(failure.message); }
  };
  return (
    <>
      <div className="rs-reports">
        <section className="pv-card rs-report-form">
          <header><h3>Report</h3><p>Name it, then download it</p></header>
          <label>Project name<input value={form.projectName} onChange={(event) => setForm({ ...form, projectName: event.target.value })} maxLength={80} /></label>
          <label>Report title<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} maxLength={100} /></label>
          <div className="rs-downloads">
            <button type="button" onClick={() => run("PDF", printReport)}>Create PDF report</button>
            <button type="button" onClick={() => run("Excel report", downloadExcel)}>Create Excel report</button>
            <button type="button" onClick={() => run("PowerPoint report", downloadPowerPoint)}>Create PowerPoint report</button>
          </div>
          {status && <p className="pv-note" role="status">{status}</p>}
          <p className="pv-note">PDF opens the print dialog: choose "Save as PDF". Excel downloads a spreadsheet file.</p>
        </section>

        <section className="pv-card rs-preview" aria-label="Report preview">
          <header><h3>{report.title}</h3><p>{report.projectName} · {report.place} · {report.sections.length} sections</p></header>
          <div className="rs-preview-grid">
            {report.sections.map((section) => (
              <article key={section.title}>
                <h4>{section.title}{section.note && <small> · {section.note}</small>}</h4>
                {section.table && (
                  <table>
                    {section.header && <thead><tr>{section.header.map((cell) => <th key={cell}>{cell}</th>)}</tr></thead>}
                    <tbody>{section.table.slice(0, 6).map((row) => <tr key={row.join("|")}>{row.map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}</tbody>
                  </table>
                )}
                {section.bullets && <ul>{section.bullets.slice(0, 3).map((item) => <li key={item}>{item}</li>)}</ul>}
              </article>
            ))}
          </div>
        </section>
      </div>
      <details className="pv-card rs-election">
        <summary>Election-day operational reports</summary>
        <ReportingLifecycle authToken={authToken} />
      </details>
    </>
  );
}

export default function ResourcesTab({ authToken }) {
  const [view, setView] = useState("plans");
  const [lga, setLga] = useState("");
  const [from, setFrom] = useState("");
  const [form, setForm] = useState({ projectName: "Sen. Sharafadeen Alli campaign", title: "Campaign situation report" });
  const [fitRef, fitHeight] = useFitHeight();
  const client = useQueryClient();
  const query = (path) => ({ signal }) => apiRequest(path, authToken, { signal });

  const plansQuery = useQuery({ queryKey: ["resources-plans"], queryFn: query("/area-operations/plans") });
  const dashboard = useQuery({ queryKey: ["resources-dashboard", lga], queryFn: query(`/area-operations/resources/dashboard${lga ? `?lga=${encodeURIComponent(lga)}` : ""}`) });
  const overview = useQuery({ queryKey: ["pre-election-overview"], queryFn: query("/pre-election/overview"), staleTime: 60_000 });
  const feedback = useQuery({ queryKey: ["feedback-analysis", lga], queryFn: query(`/feedback/analysis?lga=${encodeURIComponent(lga)}`), staleTime: 60_000 });
  const map = useQuery({ queryKey: ["pre-election-map", "", ""], queryFn: query("/pre-election/map?lga=&ward="), staleTime: 300_000 });

  const plans = useMemo(() => (plansQuery.data || [])
    .filter((plan) => (!lga || plan.lga === lga) && (!from || plan.date >= from))
    .sort((a, b) => a.date.localeCompare(b.date)), [plansQuery.data, lga, from]);
  const resources = dashboard.data?.resources || [];
  const total = (key) => resources.reduce((sum, row) => sum + (Number(row[key]) || 0), 0);
  const recorded = useMemo(() => new Map(resources.map((row) => [row.resourceType, row.available])), [resources]);

  const needs = useMemo(() => {
    const rows = map.data?.rows;
    if (!rows) return null;
    const stateRegistered = rows.reduce((sum, row) => sum + (row.values.registered || 0), 0);
    const picked = lga ? rows.filter((row) => lgaKey(row.name) === lgaKey(lga)) : rows;
    return recommendResources({
      state: !lga,
      lgas: picked.length,
      wards: picked.reduce((sum, row) => sum + (row.wards || 0), 0),
      pollingUnits: picked.reduce((sum, row) => sum + (row.pollingUnits || 0), 0),
      registered: picked.reduce((sum, row) => sum + (row.values.registered || 0), 0),
      stateRegistered,
      promoterTarget: overview.data?.tenx?.target || 750_000,
    });
  }, [map.data, lga, overview.data]);

  const place = lga ? titleCase(lga) : "Oyo State";
  const report = useMemo(() => buildReport({ ...form, place, overview: overview.data, feedback: feedback.data, resources, plans }), [form, place, overview.data, feedback.data, resources, plans]);
  const projects = plans.length + (overview.data?.projects?.total || 0);
  const requested = total("required");
  const current = VIEWS.find((item) => item.id === view);

  return (
    <section ref={fitRef} style={fitHeight ? { height: fitHeight } : undefined} className="pv rs" aria-label="Resources">
      <div className="rs-bar">
        <div className="smp-seg rs-views" role="tablist" aria-label="Resources views">
          {VIEWS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={view === item.id} className={view === item.id ? "on" : ""} onClick={() => setView(item.id)}>{item.label}</button>)}
        </div>
        <p className="rs-title">{current.title}</p>
        <div className="rs-filters">
          <label>LGA<select value={lga} onChange={(event) => setLga(event.target.value)}><option value="">All 33 LGAs</option>{getRegistrationLocationOptions("Oyo").lgas.map((name) => <option key={name} value={name}>{titleCase(name)}</option>)}</select></label>
          <label>From date<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <button type="button" className="rs-print" onClick={() => window.print()}>Print</button>
        </div>
      </div>

      <div className="pv-kpis rs-kpis">
        <div className="pv-kpi"><span>Plans and projects</span><strong>{num(projects)}</strong><small>{plans.length} plan{plans.length === 1 ? "" : "s"}{overview.data?.projects ? ` · ${num(overview.data.projects.total)} 10x projects` : ""}</small></div>
        <div className="pv-kpi"><span>Requested</span><strong>{num(requested)}</strong><small>resources asked for</small></div>
        <div className="pv-kpi"><span>Allocated</span><strong>{num(total("deployed"))}</strong><small>dispatched{requested ? ` · ${Math.round((total("deployed") / requested) * 100)}% of requested` : ""}</small></div>
        <div className="pv-kpi pv-kpi-lead"><span>Implemented</span><strong>{num(total("arrived"))}</strong><small>arrived where needed{total("missing") ? ` · ${num(total("missing"))} still missing` : ""}</small></div>
      </div>

      {view === "plans" && <PlansView authToken={authToken} lga={lga} plans={plans} critical={feedback.data?.channels?.critical} needs={needs} recorded={recorded} onPlansChanged={() => client.invalidateQueries({ queryKey: ["resources-plans"] })} />}
      {view === "resources" && <ResourceIntelligence authToken={authToken} lga={lga} onChanged={() => client.invalidateQueries({ queryKey: ["resources-dashboard"] })} />}
      {view === "reports" && <ReportsView authToken={authToken} report={report} form={form} setForm={setForm} />}
    </section>
  );
}
