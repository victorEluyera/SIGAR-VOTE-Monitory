import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useFitHeight } from "./useFitHeight.js";
import { apiRequest } from "../../api/client.js";
import "./pre-election-pulse.css";

/**
 * The Pre-Election Pulse: the first screen of pre-election. One viewport, no scrolling on a
 * laptop: headline figures, the four charts that matter, and findings written from the data.
 * Everything comes from uploads (Tools -> Manage Data), so it updates the moment new data is loaded.
 */

const num = (value) => (value == null ? "—" : Number(value).toLocaleString());
const pct = (value, digits = 0) => (value == null ? "—" : `${(Number(value) * 100).toFixed(digits)}%`);
const compact = (value) => {
  if (value == null) return "—";
  const n = Number(value);
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return n.toLocaleString();
};
const ago = (value) => {
  if (!value) return "";
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86400000);
  return days <= 0 ? "updated today" : days === 1 ? "updated yesterday" : `updated ${days} days ago`;
};

const groupShort = (label) => (/agent/i.test(label) ? "agents" : /bsa|volunteer/i.test(label) ? "BSA-YV" : label.split(" ")[0]);

const FOCUS = "#f5dc9a";
const SATISFACTION_COLORS = { "Very satisfied": "#0ca30c", Satisfied: "#7fcf7f", Neutral: "#a8929c", Dissatisfied: "#ec835a", "Very dissatisfied": "#d8452b" };
const PLATFORM_COLORS = ["#f5dc9a", "#d9aa4b", "#a8761f", "#c9748f", "#8a4a5c"];
const TONE_LABEL = { risk: "Act", watch: "Watch", good: "Strength", info: "Insight" };

function Empty({ children }) {
  return <p className="pep-empty">{children}</p>;
}

function Bars({ rows, max, total }) {
  const top = max ?? Math.max(...rows.map((row) => row.value), 1);
  return (
    <ul className="pep-bars">
      {rows.map((row) => (
        <li key={row.name} title={`${row.name}: ${num(row.value)}`}>
          <span className="pep-bar-name">{row.name}</span>
          <span className="pep-bar-track"><i style={{ width: `${Math.max((row.value / top) * 100, row.value > 0 ? 2 : 0)}%`, background: row.color }} /></span>
          <span className="pep-bar-value">{row.label ?? (total ? pct(row.value / total) : num(row.value))}</span>
        </li>
      ))}
    </ul>
  );
}

function Donut({ slices, center, sub }) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0) || 1;
  const radius = 15.9155; // circumference 100, so dash lengths are percentages
  let offset = 25;
  return (
    <div className="pep-donut">
      <svg viewBox="0 0 42 42" role="img" aria-label={slices.map((slice) => `${slice.name} ${pct(slice.value / total)}`).join(", ")}>
        <circle cx="21" cy="21" r={radius} fill="none" stroke="#3a1420" strokeWidth="6" />
        {slices.map((slice) => {
          const length = (slice.value / total) * 100;
          const node = <circle key={slice.name} cx="21" cy="21" r={radius} fill="none" stroke={slice.color} strokeWidth="6" strokeDasharray={`${length} ${100 - length}`} strokeDashoffset={offset} />;
          offset -= length;
          return node;
        })}
        <text x="21" y="21" textAnchor="middle" className="pep-donut-center">{center}</text>
        {sub && <text x="21" y="26.5" textAnchor="middle" className="pep-donut-sub">{sub}</text>}
      </svg>
      <ul className="pep-legend">
        {slices.map((slice) => (
          <li key={slice.name}><i style={{ background: slice.color }} /><span>{slice.name}</span><b>{pct(slice.value / total)}</b></li>
        ))}
      </ul>
    </div>
  );
}

function Panel({ title, sub, className = "", children, action }) {
  return (
    <section className={`pep-panel ${className}`}>
      <header>
        <div><h3>{title}</h3>{sub && <p>{sub}</p>}</div>
        {action}
      </header>
      <div className="pep-panel-body">{children}</div>
    </section>
  );
}

function Kpi({ label, value, sub, tone = "", title }) {
  return (
    <div className={`pep-kpi ${tone}`} title={title}>
      <span>{label}</span>
      <strong>{value}</strong>
      {sub && <small>{sub}</small>}
    </div>
  );
}

const shortDay = (value) => {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString([], { weekday: "short", day: "numeric" });
};

function Columns({ rows }) {
  const max = Math.max(...rows.map((row) => row.value), 1);
  return (
    <ul className="pep-columns" aria-label="Calls per day">
      {rows.map((row) => (
        <li key={row.name} title={`${row.name}: ${num(row.value)} calls`}>
          <b>{compact(row.value)}</b>
          <span><i style={{ height: `${Math.max((row.value / max) * 100, row.value > 0 ? 3 : 0)}%` }} /></span>
          <small>{row.name}</small>
        </li>
      ))}
    </ul>
  );
}

function ContactCenterPanel({ center, place }) {
  if (!center.available) return <Panel title="Contact center"><Empty>Upload the contact center report in Tools → Manage Data to see call activity.</Empty></Panel>;
  const stats = center.scope === "lga"
    ? [
        { label: "Calls", value: num(center.calls), sub: `${pct(center.shareOfState, 1)} of all` },
        { label: "People", value: num(center.unique), sub: "reached" },
        { label: "Wards", value: `${center.wardsReached}/${center.wardsTotal}`, sub: "reached", tone: center.wardsTotal && center.wardsReached / center.wardsTotal < 0.5 ? "warn" : "" },
      ]
    : [
        { label: "Calls", value: num(center.calls), sub: `${num(center.unique)} people` },
        { label: "Supporters", value: pct(center.supporters.share), sub: `${num(center.supporters.count)} confirmed` },
        { label: "Still open", value: num(center.open), sub: `${num(center.followUpRequested)} want follow-up`, tone: center.openShare >= 0.2 ? "warn" : "" },
      ];
  return (
    <Panel title="Contact center" sub={center.scope === "lga" ? `${center.period} · top caller issues` : `${center.period} · calls per day`}>
      <div className="pep-mini">
        {stats.map((stat) => (
          <div key={stat.label} className={stat.tone || ""}><span>{stat.label}</span><strong>{stat.value}</strong>{stat.sub && <small>{stat.sub}</small>}</div>
        ))}
      </div>
      {center.scope === "lga"
        ? center.themes.length
          ? <Bars rows={center.themes.slice(0, 3).map((row, index) => ({ name: row.label, value: row.calls, label: num(row.calls), color: index === 0 ? "#ec835a" : "#c9748f" }))} />
          : <p className="pep-note">No issues recorded by callers here yet.</p>
        : center.perDay?.length > 0 && <Columns rows={center.perDay.map((row) => ({ name: shortDay(row.date), value: row.calls }))} />}
    </Panel>
  );
}

function IntentionPanel({ survey }) {
  if (!survey.available) return <Panel title="Vote intention"><Empty>No survey loaded.</Empty></Panel>;
  const focus = survey.focus;
  const focusVotes = survey.candidates.find((row) => focus && row.name === focus.name)?.count || 0;
  const slices = [
    ...(focus ? [{ name: focus.short, value: focusVotes, color: FOCUS }] : []),
    { name: "Other candidates", value: survey.named - focusVotes, color: "#c9748f" },
    { name: "Undecided", value: survey.undecided, color: "#5b3a46" },
  ];
  return (
    <Panel title="Vote intention" sub={`${num(survey.responses)} respondents`}>
      <Donut slices={slices} center={pct(survey.undecided / Math.max(survey.responses, 1))} sub="undecided" />
    </Panel>
  );
}

function IssuesPanel({ survey, center }) {
  const hasCallers = center.available && center.themes?.length > 0;
  const [source, setSource] = useState(survey.available ? "survey" : "callers");
  const showing = source === "callers" && hasCallers ? "callers" : survey.available ? "survey" : hasCallers ? "callers" : "";
  const toggle = survey.available && hasCallers && (
    <div className="pep-toggle" role="group" aria-label="Issues source">
      <button type="button" className={showing === "survey" ? "on" : ""} onClick={() => setSource("survey")}>Survey</button>
      <button type="button" className={showing === "callers" ? "on" : ""} onClick={() => setSource("callers")}>Callers</button>
    </div>
  );
  if (!showing) return <Panel title="Top voter issues"><Empty>Upload the survey or a contact center report to see issues.</Empty></Panel>;
  if (showing === "callers") {
    const total = center.themes.reduce((sum, row) => sum + row.calls, 0);
    return (
      <Panel title="Issues callers raise" sub={`Grouped from callers' own words · ${center.themeUnit}`} action={toggle}>
        <Bars rows={center.themes.map((row, index) => ({ name: row.label, value: row.calls, label: num(row.calls), color: index === 0 ? "#ec835a" : "#c9748f" }))} total={total} />
      </Panel>
    );
  }
  return (
    <Panel title="Top voter issues" sub={`Survey · ${num(survey.topIssuesAnswered)} answered`} action={toggle}>
      <Bars rows={survey.topIssues.slice(0, 6).map((row, index) => ({ name: row.name, value: row.count, color: index === 0 ? FOCUS : "#d9aa4b" }))} total={survey.topIssuesAnswered} />
    </Panel>
  );
}

function SatisfactionPanel({ survey }) {
  if (!survey.available || !survey.satisfaction.length) return <Panel title="Satisfaction with government"><Empty>No survey loaded.</Empty></Panel>;
  const positive = survey.satisfaction.filter((row) => /^(very )?satisfied/i.test(row.name)).reduce((sum, row) => sum + row.count, 0);
  return (
    <Panel title="Satisfaction with government" sub={`${num(survey.satisfactionAnswered)} answered`}>
      <Donut slices={survey.satisfaction.map((row) => ({ name: row.name, value: row.count, color: SATISFACTION_COLORS[row.name] || "#a8929c" }))} center={pct(positive / Math.max(survey.satisfactionAnswered, 1))} sub="satisfied" />
    </Panel>
  );
}

function PlatformPanel({ survey }) {
  if (!survey.available || !survey.platform.length) return <Panel title="Most influential platform"><Empty>No survey loaded.</Empty></Panel>;
  return (
    <Panel title="Most influential platform" sub={`${num(survey.platformAnswered)} answered`}>
      <Donut slices={survey.platform.map((row, index) => ({ name: row.name, value: row.count, color: PLATFORM_COLORS[index] }))} center={pct(survey.platform[0].share)} sub={survey.platform[0].name} />
    </Panel>
  );
}

function GroundPanel({ data, onPick }) {
  const { members, filter, byLga, survey } = data;
  if (!members.available) return <Panel title="Ground strength"><Empty>Upload member lists in Tools → Manage Data to see polling-unit coverage.</Empty></Panel>;
  if (filter.lga) {
    const row = byLga.find((item) => item.lga === filter.lga) || {};
    return (
      <Panel title={`Ground strength · ${filter.label}`} sub={`${num(row.wards)} wards · ${num(row.pollingUnits)} polling units`}>
        <Bars rows={[
          { name: "Units covered", value: members.unitCoverage || 0, label: `${num(members.unitsCovered)} / ${num(members.pollingUnits)}`, color: FOCUS },
          { name: "Wards reached", value: members.wardsTotal ? members.wardsCovered / members.wardsTotal : 0, label: `${num(members.wardsCovered)} / ${num(members.wardsTotal)}`, color: "#d9aa4b" },
          // One bar per list only when there is more than one list to compare.
          ...(members.groups.length > 1 ? members.groups : []).map((group) => ({ name: group.label, value: group.people / Math.max(members.total, 1), label: num(group.people), color: "#c9748f" })),
        ]} max={1} />
        {survey.available && <p className="pep-note">Survey: {num(survey.responses)} responses{survey.candidates[0] ? `, ${survey.candidates[0].short} leads with ${pct(survey.candidates[0].share)}` : ""}.</p>}
      </Panel>
    );
  }
  // Members listed without polling-unit numbers cannot be placed, so their coverage is unknown, not 0%.
  const weakest = byLga
    .filter((row) => !(row.members > 0 && !row.unitsCovered))
    .map((row) => ({ ...row, coverage: row.pollingUnits ? row.unitsCovered / row.pollingUnits : 0 }))
    .sort((a, b) => a.coverage - b.coverage || b.pollingUnits - a.pollingUnits)
    .slice(0, 6);
  const unplaced = byLga.filter((row) => row.members > 0 && !row.unitsCovered).map((row) => row.label);
  return (
    <Panel title="Weakest polling-unit coverage" sub="Units with a member · click an LGA to focus">
      <ul className="pep-bars pep-clickable">
        {weakest.map((row) => (
          <li key={row.lga}>
            <button type="button" onClick={() => onPick(row.lga)} title={`${row.label}: ${num(row.unitsCovered)} of ${num(row.pollingUnits)} polling units, ${num(row.members)} members`}>
              <span className="pep-bar-name">{row.label}</span>
              <span className="pep-bar-track"><i style={{ width: `${Math.max(row.coverage * 100, row.coverage > 0 ? 2 : 0)}%`, background: row.coverage < 0.25 ? "#ec835a" : "#d9aa4b" }} /></span>
              <span className="pep-bar-value">{pct(row.coverage)}</span>
            </button>
          </li>
        ))}
      </ul>
      {unplaced.length > 0 && <p className="pep-note pep-clamp" title={unplaced.join(", ")}>No polling-unit numbers given for {unplaced.join(", ")}.</p>}
    </Panel>
  );
}

function InsightsPanel({ insights }) {
  return (
    <Panel title="Intelligence" sub="Written from the loaded data" className="pep-insights">
      {insights.length ? (
        <ol>
          {insights.map((item, index) => (
            <li key={index} className={`pep-insight ${item.tone}`}><span>{TONE_LABEL[item.tone]}</span><p>{item.text}</p></li>
          ))}
        </ol>
      ) : <Empty>Load data to generate findings.</Empty>}
    </Panel>
  );
}

export default function PreElectionPulse({ authToken, onOpenData }) {
  const [lga, setLga] = useState("");
  const [fitRef, fitHeight] = useFitHeight();
  const query = useQuery({
    queryKey: ["pre-election-pulse", lga],
    queryFn: ({ signal }) => apiRequest(`/pre-election/pulse?lga=${encodeURIComponent(lga)}`, authToken, { signal }),
    placeholderData: (previous) => previous,
    staleTime: 30_000,
  });

  if (query.isError) return <section className="pep" ref={fitRef}><Empty>{query.error.message}</Empty></section>;
  if (!query.data) return <section className="pep" ref={fitRef}><Empty>Loading the pre-election pulse…</Empty></section>;

  const data = query.data;
  const { survey, members, contacts, reference, register } = data;
  const tenx = data.tenx || { available: false };
  const leader = survey.available ? survey.candidates[0] : null;
  const runnerUp = survey.available ? survey.candidates[1] : null;

  const overviewStats = [
    { label: "REGISTERED VOTERS", value: compact(reference.registeredVoters?.value ?? 3280000), sub: "2.76% collected their PVC" },
    { label: "APC", value: compact(500000), sub: "84.3% of register" },
    { label: "Members", value: compact(157289), sub: "4.8% of registered voters" },
    { label: "10X POLLING UNIT PROMOTERS", value: compact(5832), sub: "2% of 750,000 target" },
    { label: "COMMUNITY PROJECTS", value: compact(300), sub: "300 / 351 Wards Covered" },
    { label: "Wards", value: compact(5992), sub: "of 0.390 · 04%" },
  ];

  const topIssues = [
    { name: "Economic hardship", value: 47 },
    { name: "Security", value: 28 },
    { name: "Infrastructure", value: 19 },
    { name: "Jobs", value: 14 },
  ];

  const communityProjects = [
    { name: "Submitted", value: 100 },
    { name: "Ongoing", value: 50 },
    { name: "Completed", value: 10 },
    { name: "Not Started", value: 40 },
  ];

  const criticalIntelligence = [
    "1. Places with the weakest coverage",
    "2. Places with the low sentiment",
    "3. No project submitted or ongoing",
    "4. On media",
  ];

  const sentimentBars = [
    { name: "Very positive", value: 71.9, color: "#f5dc9a" },
    { name: "Positive", value: 54.2, color: "#d9aa4b" },
    { name: "Neutral", value: 46.8, color: "#c9748f" },
    { name: "Negative", value: 43.6, color: "#8a4a5c" },
  ];

  return (
    <section ref={fitRef} style={fitHeight ? { height: fitHeight } : undefined} className={`pep${query.isFetching ? " pep-busy" : ""}`} aria-label="Pre-election pulse">
      <header className="pep-head pep-header-override">
        <div>
          <span className="eyebrow">PRE-ELECTION DASHBOARD</span>
          <h2>Pre-Election Dashboard</h2>
        </div>
        <div className="pep-head-actions">
          <span className="pep-head-summary">Overview, voter and feedback analysis, insight, next actions and resources.</span>
          <label>
            <span>LGA</span>
            <select value={lga} onChange={(event) => setLga(event.target.value)} aria-label="Filter the pulse by LGA">
              <option value="">All 33 LGAs</option>
              {data.filter.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          {lga && <button type="button" className="pep-link" onClick={() => setLga("")}>Clear</button>}
          {data.canUpload && onOpenData && <button type="button" className="pep-link" onClick={onOpenData}>Manage data</button>}
        </div>
      </header>

      <nav className="pep-tabs" aria-label="Pre-election tabs">
        <button type="button" className="pep-tab active">Overview</button>
        <button type="button" className="pep-tab">Insights</button>
        <button type="button" className="pep-tab">Feedback</button>
        <button type="button" className="pep-tab">Resource</button>
      </nav>

      <div className="pep-kpis pep-kpis-compact">
        {overviewStats.map((stat) => (
          <div key={stat.label} className="pep-kpi pep-kpi-card">
            <span>{stat.label}</span>
            <strong>{stat.value}</strong>
            <small>{stat.sub}</small>
          </div>
        ))}
      </div>

      <div className="pep-overview-grid">
        <div className="pep-overview-main">
          <div className="pep-box pep-box--donut">
            <div className="pep-box-header">
              <h3>Vote intention</h3>
              <span>23,836 respondents</span>
            </div>
            <div className="pep-donut-wrap">
              <div className="pep-donut-chart">
                <div className="pep-ring">
                  <div className="pep-ring-inner">
                    <strong>49%</strong>
                    <small>Undecided</small>
                  </div>
                </div>
              </div>
              <ul className="pep-donut-legend">
                <li><span className="dot dot-pink" />Adekemni Ambi</li>
                <li><span className="dot dot-blue" />Hamzat Oryomi</li>
                <li><span className="dot dot-gold" />Undecided</li>
              </ul>
            </div>
          </div>

          <div className="pep-box pep-box--coverage">
            <div className="pep-box-header">
              <h3>Weakest Polling-Unit Coverage</h3>
              <button type="button" className="pep-lite-button">View all</button>
            </div>
            <div className="pep-table-wrap">
              <table className="pep-mini-table">
                <tbody>
                  <tr><td>1 Orile</td><td>82%</td><td>12/137</td></tr>
                  <tr><td>2 Ijewajo</td><td>82%</td><td>12/137</td></tr>
                  <tr><td>3 Aji</td><td>84%</td><td>101/120</td></tr>
                  <tr><td>4 Kajola</td><td>85%</td><td>130/153</td></tr>
                  <tr><td>5 Lagelu</td><td>86%</td><td>142/165</td></tr>
                  <tr><td>6 Asto</td><td>87%</td><td>129/148</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="pep-box pep-box--sentiment">
            <div className="pep-box-header">
              <h3>Share of Sentiment</h3>
            </div>
            <div className="pep-small-bars">
              {sentimentBars.map((bar) => (
                <div key={bar.name} className="pep-small-bar-group">
                  <div className="pep-small-bar" style={{ height: `${bar.value}%`, background: bar.color }} />
                  <small>{bar.value.toFixed(1)}%</small>
                </div>
              ))}
            </div>
          </div>

          <div className="pep-box pep-box--influencers">
            <div className="pep-box-header">
              <h3>Influencers</h3>
            </div>
            <div className="pep-bubble-panel">
              <div className="pep-bubble bubble-1">#0yoAhead</div>
              <div className="pep-bubble bubble-2">#APM</div>
              <div className="pep-bubble bubble-3">#BAM2027</div>
              <div className="pep-bubble bubble-4">#APM</div>
              <div className="pep-bubble bubble-5">#BAM2027</div>
            </div>
          </div>
        </div>

        <aside className="pep-overview-side">
          <div className="pep-box pep-box--projects">
            <div className="pep-box-header">
              <h3>Community Projects</h3>
              <button type="button" className="pep-lite-button">View all</button>
            </div>
            <div className="pep-project-stats">
              {communityProjects.map((project) => (
                <div key={project.name} className="pep-project-stat">
                  <strong>{project.value}</strong>
                  <span>{project.name}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="pep-box pep-box--critical">
            <div className="pep-box-header">
              <h3>5 Critical Intelligence</h3>
            </div>
            <ol className="pep-critical-list">
              {criticalIntelligence.map((item, index) => (
                <li key={item}>
                  <span>{index + 1}.</span>
                  <strong>{item.replace(/^\d+\.\s*/, "")}</strong>
                </li>
              ))}
            </ol>
          </div>

          <div className="pep-box pep-box--notes">
            <p>702 calls (36%) are still open and 147 callers asked for a follow-up. Close these before the next outreach round.</p>
            <p>Callers most often raise electricity &amp; street lights (361), roads &amp; bridges (287), money &amp; financial support (248).</p>
            <p>Activate Windows</p>
          </div>
        </aside>
      </div>
    </section>
  );
}
