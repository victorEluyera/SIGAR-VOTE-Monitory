import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiRequest } from "../../api/client.js";
import { useFitHeight } from "./useFitHeight.js";
import "./pre-election-views.css";

/**
 * Feedback analysis: what people are telling the campaign, from the field survey, the feedback
 * form (share links and signed-in field agents), the call center and 10x, compared side by side
 * and combined into one ranking of what they are asking for. Admins manage share links and the
 * proposed projects voters rate here.
 */

const CHANNELS = [
  { id: "field", label: "Field survey", color: "#d9aa4b" },
  { id: "link", label: "Feedback form", color: "#5ec8ff" },
  { id: "callers", label: "Call center", color: "#c9748f" },
];
const QUESTION_TITLES = {
  respondent: "Who they are",
  topIssue: "Top priority issue",
  satisfaction: "Satisfaction with the government",
  sector: "Sector needing urgent improvement",
  fairAttention: "LGA getting fair attention",
  lgaProblem: "Biggest problem in their LGA",
  communicate: "What leaders should explain more clearly",
  hasPvc: "Has a PVC",
  votedLast: "Voted in the last election",
  likelihood: "Likely to vote",
  barrier: "What could stop them voting",
  platform: "Where they get political information",
  truthSource: "Who they trust",
  candidateFactor: "What matters most in a candidate",
  familiarity: "Familiar with Sen. Alli",
  goodGovernor: "Sen. Alli would make a good governor",
};
const SCALE_COLORS = ["#2e7d32", "#7cb342", "#8f7d86", "#e67e22", "#c0392b"];
const num = (value) => (value == null ? "—" : Number(value).toLocaleString());
const pct = (value) => (value == null ? "—" : `${Math.round(value * 100)}%`);
const shareUrl = (token) => `${window.location.origin}/feedback/${token}`;

function Bars({ rows }) {
  const max = Math.max(...rows.flatMap((row) => CHANNELS.map((channel) => row[channel.id] || 0)), 0.01);
  return (
    <ul className="fb-bars">
      {rows.map((row) => (
        <li key={row.name || row.id}>
          <span>{row.label || row.name}</span>
          <div>
            {CHANNELS.filter((channel) => row[channel.id] !== undefined).map((channel) => (
              <em key={channel.id} title={`${channel.label}: ${pct(row[channel.id])}`}>
                <u style={{ width: `${((row[channel.id] || 0) / max) * 100}%`, background: channel.color }} />
                <b>{row[channel.id] == null ? "—" : pct(row[channel.id])}</b>
              </em>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Legend({ only }) {
  return (
    <p className="fb-legend">
      {CHANNELS.filter((channel) => !only || only.includes(channel.id)).map((channel) => <span key={channel.id}><i style={{ background: channel.color }} />{channel.label}</span>)}
    </p>
  );
}

/** One answer scale as a single stacked bar, labelled underneath. */
function Scale({ title, scale }) {
  if (!scale.answered) return <div className="fb-scale"><h4>{title}</h4><p className="pv-note">No answers yet.</p></div>;
  return (
    <div className="fb-scale">
      <h4>{title} <small>{num(scale.answered)} answers</small></h4>
      <div className="pv-stack">{scale.rows.map((row, i) => <i key={row.name} title={`${row.name}: ${pct(row.share)}`} style={{ width: `${(row.share || 0) * 100}%`, background: SCALE_COLORS[Math.min(i, SCALE_COLORS.length - 1)] }} />)}</div>
      <ul className="fb-scale-legend">{scale.rows.map((row, i) => <li key={row.name}><i style={{ background: SCALE_COLORS[Math.min(i, SCALE_COLORS.length - 1)] }} />{row.name} <b>{pct(row.share)}</b></li>)}</ul>
    </div>
  );
}

function LinkManager({ authToken, lgas }) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [lga, setLga] = useState("");
  const [message, setMessage] = useState("");
  const links = useQuery({ queryKey: ["feedback-links"], queryFn: ({ signal }) => apiRequest("/feedback/links", authToken, { signal }) });
  const refresh = () => { queryClient.invalidateQueries({ queryKey: ["feedback-links"] }); queryClient.invalidateQueries({ queryKey: ["feedback-analysis"] }); };
  const create = async (event) => {
    event.preventDefault();
    try {
      const link = await apiRequest("/feedback/links", authToken, { method: "POST", body: JSON.stringify({ label, lga }) });
      setLabel(""); setLga("");
      await navigator.clipboard?.writeText(shareUrl(link.token)).catch(() => {});
      setMessage(`Link created and copied: ${shareUrl(link.token)}`);
      refresh();
    } catch (failure) { setMessage(failure.message); }
  };
  const toggle = async (link) => {
    await apiRequest(`/feedback/links/${link.id}`, authToken, { method: "PUT", body: JSON.stringify({ active: !link.active }) }).catch((failure) => setMessage(failure.message));
    refresh();
  };
  const copy = async (link) => {
    try { await navigator.clipboard.writeText(shareUrl(link.token)); setMessage(`Copied: ${shareUrl(link.token)}`); } catch { setMessage(shareUrl(link.token)); }
  };
  return (
    <section className="pv-card">
      <header><h3>Share links</h3><p>Anyone with a link can fill the questionnaire, no sign-in needed. Field agents signed in on their phone are credited automatically. Make one link per channel or area.</p></header>
      <form className="fb-new" onSubmit={create}>
        <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Name, e.g. WhatsApp – Ibadan North" maxLength={80} aria-label="Link name" />
        <select value={lga} onChange={(event) => setLga(event.target.value)} aria-label="Limit to one LGA">
          <option value="">Any LGA</option>
          {lgas.map((item) => <option key={item.lga} value={item.lga}>{item.name}</option>)}
        </select>
        <button type="submit" disabled={!label.trim()}>Create link</button>
      </form>
      {message && <p className="fb-message" role="status">{message}</p>}
      <ul className="fb-links">
        {(links.data || []).map((link) => (
          <li key={link.id} className={link.active ? "" : "off"}>
            <div><b>{link.label}</b><small>{link.lga ? `${link.lga} only · ` : ""}{num(link.responses)} answers · {link.active ? "active" : "switched off"}</small></div>
            <button type="button" onClick={() => copy(link)} disabled={!link.active}>Copy link</button>
            <a href={shareUrl(link.token)} target="_blank" rel="noreferrer">Open</a>
            <button type="button" onClick={() => toggle(link)}>{link.active ? "Switch off" : "Switch on"}</button>
          </li>
        ))}
        {links.data && !links.data.length && <li className="fb-empty">No links yet.</li>}
      </ul>
    </section>
  );
}

function ProjectManager({ authToken, lgas }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ title: "", lga: "", ward: "", candidate: "" });
  const [message, setMessage] = useState("");
  const wards = useQuery({
    queryKey: ["feedback-project-wards", form.lga],
    enabled: Boolean(form.lga),
    queryFn: ({ signal }) => apiRequest(`/pre-election/map?lga=${encodeURIComponent(form.lga)}`, authToken, { signal }).then((data) => data.rows.map((row) => ({ number: row.number, name: row.name }))),
    staleTime: 3_600_000,
  });
  const create = async (event) => {
    event.preventDefault();
    try {
      await apiRequest("/feedback/projects", authToken, { method: "POST", body: JSON.stringify(form) });
      setForm((current) => ({ ...current, title: "", candidate: "" }));
      setMessage("Project added. It now appears on the form for voters in that area.");
      queryClient.invalidateQueries({ queryKey: ["feedback-analysis"] });
    } catch (failure) { setMessage(failure.message); }
  };
  return (
    <section className="pv-card">
      <header><h3>Proposed projects</h3><p>Question 16: voters in the chosen LGA (or ward) rate how much each project is needed, from 1 to 10.</p></header>
      <form className="fb-project" onSubmit={create}>
        <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Project, e.g. Borehole at Oja Oba" maxLength={120} aria-label="Project" />
        <select value={form.lga} onChange={(event) => setForm({ ...form, lga: event.target.value, ward: "" })} aria-label="LGA">
          <option value="">LGA</option>
          {lgas.map((item) => <option key={item.lga} value={item.lga}>{item.name}</option>)}
        </select>
        <select value={form.ward} onChange={(event) => setForm({ ...form, ward: event.target.value })} disabled={!form.lga} aria-label="Ward">
          <option value="">Whole LGA</option>
          {(wards.data || []).map((ward) => <option key={ward.number} value={ward.number}>{ward.name}</option>)}
        </select>
        <input value={form.candidate} onChange={(event) => setForm({ ...form, candidate: event.target.value })} placeholder="Proposed by (optional)" maxLength={80} aria-label="Proposed by" />
        <button type="submit" disabled={!form.title.trim() || !form.lga}>Add project</button>
      </form>
      {message && <p className="fb-message" role="status">{message}</p>}
    </section>
  );
}

export default function FeedbackAnalysisTab({ authToken }) {
  const [lga, setLga] = useState("");
  const [fitRef, fitHeight] = useFitHeight();
  const query = useQuery({
    queryKey: ["feedback-analysis", lga],
    queryFn: ({ signal }) => apiRequest(`/feedback/analysis?lga=${encodeURIComponent(lga)}`, authToken, { signal }),
    placeholderData: (previous) => previous,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const data = query.data;
  if (query.isError && !data) return <section className="pv" ref={fitRef}><p className="pv-empty">{query.error.message}</p></section>;
  if (!data) return <section className="pv" ref={fitRef}><p className="pv-empty">Loading the feedback analysis…</p></section>;

  const s = data.sources;
  const allLgas = data.byLga.slice().sort((a, b) => a.name.localeCompare(b.name));
  const p = data.perception;
  return (
    <section ref={fitRef} style={fitHeight ? { height: fitHeight } : undefined} className={`pv${query.isFetching ? " pv-busy" : ""}`} aria-label="Feedback analysis">
      <div className="pv-bar">
        <p className="pv-headline-title" style={{ fontSize: 18 }}>What people are telling us · {data.place}</p>
        <label className="fb-filter">LGA
          <select value={lga} onChange={(event) => setLga(event.target.value)}>
            <option value="">All 33 LGAs</option>
            {data.lga ? <option value={data.lga}>{data.place}</option> : allLgas.map((row) => <option key={row.lga} value={row.lga}>{row.name}</option>)}
          </select>
        </label>
      </div>

      <div className="pv-kpis">
        <div className="pv-kpi"><span>Field survey</span><strong>{num(s.field.responses)}</strong><small>answers in the field survey file</small></div>
        <div className="pv-kpi"><span>Feedback form</span><strong>{num(s.form.responses)}</strong><small>{num(s.form.byAgents)} by {num(s.form.agents)} agent{s.form.agents === 1 ? "" : "s"} · {num(s.form.public)} public</small></div>
        <div className="pv-kpi"><span>Call center</span><strong>{num(s.callCenter.calls)}</strong><small>{s.callCenter.available ? `calls${s.callCenter.period ? ` · ${s.callCenter.period}` : ""}` : "no report loaded"}</small></div>
        <div className="pv-kpi"><span>10x surveys</span><strong>{s.tenx.responses != null ? num(s.tenx.responses) : "—"}</strong><small>{!s.tenx.available ? "oyo10x not connected" : data.lga ? "state-wide only" : `${num(s.tenx.surveys)} surveys · totals only`}</small></div>
        <div className="pv-kpi pv-kpi-lead"><span>Sen. Alli, first choice</span><strong>{pct(data.intention.field.share)}</strong><small>field survey{data.intention.link.named >= 10 ? ` · ${pct(data.intention.link.share)} on the form` : ""}</small></div>
      </div>

      <div className="pv-main">
        <div className="pv-side">
          <section className="pv-card">
            <header><h3>What people are asking for</h3><p>Every channel on one scale: share of each channel's answers that name the need</p></header>
            <Legend />
            <Bars rows={data.needs} />
          </section>
          <section className="pv-card">
            <header><h3>How people see Sen. Alli</h3><p>Feedback form, questions 14–15</p></header>
            <div className="fb-scales">
              <Scale title="Overall impression" scale={p.impression} />
              <Scale title="Would make a good governor" scale={p.goodGovernor} />
              <Scale title="How familiar they are with him" scale={p.familiarity} />
            </div>
            {p.reasons.answers > 0 && (
              <>
                <h4 className="fb-sub">Why they say so <small>{num(p.reasons.answers)} reasons · {pct(p.reasons.positive)} positive · {pct(p.reasons.negative)} negative</small></h4>
                <ul className="pv-list">{p.reasons.themes.map((theme) => <li key={theme.id}><span>{theme.label}</span><b>{pct(theme.share)}</b></li>)}</ul>
                {p.reasons.quotes.length > 0 && <p className="pv-note">{p.reasons.quotes.map((quote) => `“${quote.phrase}” (${quote.count})`).join(" · ")}</p>}
              </>
            )}
          </section>
        </div>

        <div className="pv-side">
          <section className="pv-card">
            <header><h3>Intelligence from the people</h3><p>{data.place}</p></header>
            <ol className="pv-intel">{data.insights.map((item) => <li key={item.text} className={item.tone}>{item.text}</li>)}</ol>
          </section>
          {data.canManage && <LinkManager authToken={authToken} lgas={allLgas} />}
        </div>
      </div>

      <section className="pv-card">
        <header><h3>Question by question</h3><p>Field survey against the feedback form: the same questionnaire, the field survey's older wording mapped onto the form's answers</p></header>
        <Legend only={["field", "link"]} />
        <div className="fb-questions">
          {data.questions.filter((question) => question.fieldAnswered || question.linkAnswered).map((question) => (
            <div key={question.id}>
              <h4>Q{question.n} · {QUESTION_TITLES[question.id]} <small>{num(question.fieldAnswered)} field · {num(question.linkAnswered)} form</small></h4>
              <Bars rows={question.rows.slice(0, 6).map((row) => ({ name: row.name, field: row.field, link: row.link }))} />
            </div>
          ))}
        </div>
      </section>

      <div className="pv-main">
        <section className="pv-card">
          <header><h3>Projects voters say they need</h3><p>Question 16 · average need from 1 to 10, and how many rated it 8 or more</p></header>
          {data.projects.length ? (
            <div className="pv-table-wrap fb-table">
              <table className="pv-table">
                <thead><tr><th>Project</th><th>Area</th><th className="num">Ratings</th><th className="num">Average</th><th className="num">Rated 8+</th></tr></thead>
                <tbody>
                  {data.projects.map((project) => (
                    <tr key={project.id} className={project.active ? "" : "fb-silent"}>
                      <th scope="row">{project.title}{project.candidate ? <small> · {project.candidate}</small> : null}</th>
                      <td>{project.lga}{project.ward ? ` · ${project.ward}` : ""}</td>
                      <td className="num">{num(project.ratings)}</td>
                      <td className="num"><b>{project.average ?? "—"}</b></td>
                      <td className="num">{pct(project.urgent)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="pv-note">No projects yet.{data.canManage ? " Add the proposed projects below so voters can rate them." : ""}</p>}
          {data.canManage && <ProjectManager authToken={authToken} lgas={allLgas} />}
        </section>

        <div className="pv-side">
          <section className="pv-card">
            <header><h3>Facilities and problem spots</h3><p>Question 17 · {num(data.facilities.total)} reported · {num(data.facilities.pinned)} with a location</p></header>
            {data.facilities.byType.length ? <ul className="pv-list">{data.facilities.byType.map((row) => <li key={row.type}><span>{row.type}</span><b>{num(row.count)}</b></li>)}</ul> : <p className="pv-note">Nothing reported yet.</p>}
            {data.facilities.recent?.length > 0 && (
              <ul className="fb-reports">
                {data.facilities.recent.map((report) => (
                  <li key={`${report.at}-${report.type}`}>
                    <b>{report.type}</b> · {report.lga}{report.ward ? `, ${report.ward}` : ""}
                    {report.note && <span>{report.note}</span>}
                    {report.lat != null && <a href={`https://www.google.com/maps?q=${report.lat},${report.lng}`} target="_blank" rel="noreferrer">Open on map</a>}
                  </li>
                ))}
              </ul>
            )}
          </section>
          {data.agents && (
            <section className="pv-card">
              <header><h3>Field agents</h3><p>Question 18 · forms credited to signed-in agents</p></header>
              {data.agents.length ? <ul className="pv-list">{data.agents.map((agent) => <li key={agent.name}><span>{agent.name}</span><b>{num(agent.count)}</b></li>)}</ul> : <p className="pv-note">No agent has filled the form yet.</p>}
            </section>
          )}
        </div>
      </div>

      <section className="pv-card">
        <header><h3>Feedback by LGA</h3><p>How many voices each LGA has given, and what it asks for most</p></header>
        <div className="pv-table-wrap fb-table">
          <table className="pv-table">
            <thead><tr><th>LGA</th><th className="num">Field survey</th><th className="num">Form</th><th className="num">Calls</th><th className="num">Facilities</th><th>Asks most for</th></tr></thead>
            <tbody>
              {data.byLga.map((row) => (
                <tr key={row.lga} className={!row.field && !row.link && !row.calls ? "fb-silent" : ""}>
                  <th scope="row">{row.name}</th>
                  <td className="num">{num(row.field)}</td>
                  <td className="num">{num(row.link)}</td>
                  <td className="num">{num(row.calls)}</td>
                  <td className="num">{num(row.facilities)}</td>
                  <td>{row.topNeed || "No feedback yet"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
