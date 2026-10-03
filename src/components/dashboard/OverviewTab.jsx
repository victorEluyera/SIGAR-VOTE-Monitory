import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { apiRequest } from "../../api/client.js";
import { useFitHeight } from "./useFitHeight.js";
import "./pre-election-views.css";

/**
 * Overview: where the party stands, for the candidate and stakeholders. A strip of headline
 * numbers, then four cards (the poll, weakest coverage, community projects, five things to act
 * on), then the online conversation. Figures come from /api/pre-election/overview, built from the
 * same data as the Pulse and the Insight map.
 */

export const US = "#d9aa4b";
export const RIVAL = "#b061c9";
const POLL_COLORS = { us: US, others: "#8f7d86", none: "#5a2a3b" };
const STATUS_COLORS = { risk: "#d9493a", watch: "#f2c14e", good: "#3fa34d" };
const STAGES = [
  { id: "submitted", label: "Submitted", color: "#8f7d86" },
  { id: "ongoing", label: "Ongoing", color: "#f2c14e" },
  { id: "completed", label: "Completed", color: "#3fa34d" },
  { id: "notStarted", label: "Not started", color: "#5a2a3b" },
];
export const SENTIMENT_COLORS = { positive: "#3fa34d", neutral: "#e0b43a", negative: "#d9493a" };
export const EMOTION_COLORS = { anger: "#d9493a", joy: "#2bb5a8", love: "#c0508f", sadness: "#5b6fd1", other: "#8f7d86" };

const num = (value) => (value == null ? "—" : Number(value).toLocaleString());
const pct = (value, digits = 0) => (value == null ? "—" : `${(value * 100).toFixed(digits)}%`);
export const compact = (value) => {
  if (value == null) return "—";
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 1 : 2).replace(/\.?0+$/, "")}M`;
  if (value >= 1e4) return `${(value / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return Number(value).toLocaleString();
};

function Kpi({ label, value, note, meter, lead = false }) {
  return (
    <div className={`pv-kpi${lead ? " pv-kpi-lead" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
      {meter != null && <div className="pv-meter" aria-hidden="true"><i style={{ width: `${Math.min(Math.max(meter, 0.004), 1) * 100}%` }} /></div>}
    </div>
  );
}

function Card({ title, sub, className = "", children }) {
  return (
    <section className={`pv-card ${className}`}>
      <header><h3>{title}</h3>{sub && <p>{sub}</p>}</header>
      {children}
    </section>
  );
}

function Donut({ split }) {
  const r = 54;
  const length = 2 * Math.PI * r;
  let offset = 0;
  const undecided = split.find((item) => item.id === "none");
  return (
    <svg viewBox="0 0 132 132" width="132" height="132" role="img" aria-label={split.map((item) => `${item.label} ${pct(item.share)}`).join(", ")}>
      <g transform="rotate(-90 66 66)" fill="none" strokeWidth="16">
        <circle cx="66" cy="66" r={r} stroke="#3a0f1d" />
        {split.map((item) => {
          const dash = item.share * length;
          const circle = <circle key={item.id} cx="66" cy="66" r={r} stroke={POLL_COLORS[item.id]} strokeDasharray={`${Math.max(dash - 1.5, 0)} ${length}`} strokeDashoffset={-offset} />;
          offset += dash;
          return circle;
        })}
      </g>
      <text x="66" y="64" textAnchor="middle" fill="#f7eff2" fontSize="22" fontWeight="600">{pct(undecided?.share)}</text>
      <text x="66" y="80" textAnchor="middle" fill="#cfa7b3" fontSize="11">not decided</text>
    </svg>
  );
}

/** One horizontal bar split into parts, with the largest part labelled inside. */
function SplitBar({ label, parts, colors, labels }) {
  const entries = Object.entries(parts);
  const [topKey] = entries.reduce((best, entry) => (entry[1] > best[1] ? entry : best), entries[0]);
  return (
    <div className="pv-split">
      <span>{label}</span>
      <div className="pv-splitbar" role="img" aria-label={`${label}: ${entries.map(([key, value]) => `${labels[key]} ${value}%`).join(", ")}`}>
        {entries.map(([key, value]) => (
          <i key={key} style={{ width: `${value}%`, background: colors[key] }} title={`${labels[key]} ${value}%`}>
            {key === topKey ? `${value}% ${labels[key].toLowerCase()}` : value >= 12 ? `${value}%` : ""}
          </i>
        ))}
      </div>
    </div>
  );
}

export function ShareCard({ title, sub, block, subjects, colors }) {
  return (
    <Card title={title} sub={sub}>
      <SplitBar label={subjects.us} parts={block.us} colors={colors} labels={block.labels} />
      <SplitBar label={subjects.rival} parts={block.rival} colors={colors} labels={block.labels} />
      <table className="pv-mini">
        <thead><tr><th /><th>{subjects.us}</th><th>{subjects.rival.split(" ")[0]}</th></tr></thead>
        <tbody>
          {Object.keys(block.labels).map((key) => (
            <tr key={key}><td><i style={{ background: colors[key] }} />{block.labels[key]}</td><td>{block.us[key]}%</td><td>{block.rival[key]}%</td></tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** Greedy circle packing: biggest first, each next circle at the nearest free spot to the centre. */
function packBubbles(items, width, height) {
  const max = Math.max(...items.map((item) => item.count), 1);
  const scale = Math.min(width, height) * 0.27;
  const placed = [];
  for (const item of [...items].sort((a, b) => b.count - a.count)) {
    const r = Math.max(Math.sqrt(item.count / max) * scale, 12);
    let spot = null;
    for (let step = 0; step < 900 && !spot; step += 1) {
      const angle = step * 0.35;
      const distance = step * 0.55;
      const x = width / 2 + Math.cos(angle) * distance * 1.35;
      const y = height / 2 + Math.sin(angle) * distance;
      const inside = x - r >= 0 && x + r <= width && y - r >= 0 && y + r <= height;
      if (inside && placed.every((other) => Math.hypot(other.x - x, other.y - y) >= other.r + r + 2)) spot = { x, y };
    }
    if (spot) placed.push({ ...item, ...spot, r });
  }
  return placed;
}

export function Hashtags({ tags }) {
  const bubbles = useMemo(() => packBubbles(tags, 320, 190), [tags]);
  return (
    <svg viewBox="0 0 320 190" width="100%" role="img" aria-label={tags.map((tag) => `${tag.tag} ${tag.count}`).join(", ")}>
      {bubbles.map((bubble) => {
        const fits = bubble.r * 2 > bubble.tag.length * 6.4;
        const ink = bubble.side === "us" ? "#2a1406" : "#fff";
        return (
          <g key={bubble.tag}>
            <title>{`${bubble.tag}: ${bubble.count}`}</title>
            <circle cx={bubble.x} cy={bubble.y} r={bubble.r} fill={bubble.side === "us" ? US : RIVAL} opacity={bubble.side === "us" ? 1 : 0.85} />
            {fits && <text x={bubble.x} y={bubble.y - 2} textAnchor="middle" fill={ink} fontSize="11.5" fontWeight="600">{bubble.tag}</text>}
            <text x={bubble.x} y={bubble.y + (fits ? 12 : 4)} textAnchor="middle" fill={ink} fontSize="11">{bubble.count}</text>
          </g>
        );
      })}
    </svg>
  );
}

function Online({ online }) {
  const { subjects, totals } = online;
  const rows = [["Mentions", totals.mentions], ["Engagement", totals.engagement], ["Potential reach", totals.reach]];
  const top = (side) => online.hashtags.filter((tag) => tag.side === side).slice(0, 3);
  return (
    <>
      <div className="pv-section">
        <h2>Online conversation</h2>
        <span>{online.period.label}</span>
        <div className="pv-key">
          <span><i style={{ background: US }} />{subjects.us}</span>
          <span><i style={{ background: RIVAL }} />{subjects.rival}</span>
        </div>
      </div>
      <div className="pv-row pv-online">
        <ShareCard title="Share of sentiment" sub="Every mention: positive, neutral or negative" block={online.sentiment} subjects={subjects} colors={SENTIMENT_COLORS} />
        <ShareCard title="Share of emotion" sub="The feeling each mention carries" block={online.emotion} subjects={subjects} colors={EMOTION_COLORS} />
        <Card title="Influence and reach" sub="Size of the conversation">
          <ul className="pv-cmp">
            {rows.map(([label, pair]) => (
              <li key={label}>
                <span>{label}<b>{compact(pair.us)} · {compact(pair.rival)}</b></span>
                <div><u style={{ width: `${(pair.us / (pair.us + pair.rival)) * 100}%`, background: US }} /><u style={{ width: `${(pair.rival / (pair.us + pair.rival)) * 100}%`, background: RIVAL }} /></div>
              </li>
            ))}
          </ul>
          <p className="pv-note">Biggest voices on {subjects.us}</p>
          <ul className="pv-list">
            {online.voices.slice(0, 4).map((voice) => (
              <li key={voice.name}><span>{voice.name}{voice.sentiment === "negative" && <em className="pv-neg"> negative</em>}</span><b>{compact(voice.reach)}</b></li>
            ))}
          </ul>
        </Card>
        <Card title="Hashtags" sub="Bubble size shows how often each was used">
          <Hashtags tags={online.hashtags} />
          <ul className="pv-tags">
            {["us", "rival"].map((side) => (
              <li key={side}><i style={{ background: side === "us" ? US : RIVAL }} />{top(side).map((tag) => `${tag.tag} ${tag.count}`).join(" · ")}</li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

export default function OverviewTab({ authToken, onOpenLga }) {
  const [fitRef, fitHeight] = useFitHeight();
  const query = useQuery({
    queryKey: ["pre-election-overview"],
    queryFn: ({ signal }) => apiRequest("/pre-election/overview", authToken, { signal }),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const data = query.data;
  if (query.isError) return <section className="pv" ref={fitRef}><p className="pv-empty">{query.error.message}</p></section>;
  if (!data) return <section className="pv" ref={fitRef}><p className="pv-empty">Loading the overview…</p></section>;

  const { intention, numbers, tenx, projects, coverage, intelligence, online } = data;
  const stageTotal = projects?.stages ? STAGES.reduce((sum, stage) => sum + (projects.stages[stage.id] || 0), 0) : 0;

  return (
    <section ref={fitRef} style={fitHeight ? { height: fitHeight } : undefined} className="pv pv-overview" aria-label="Overview">
      <div className="pv-kpis pv-kpis-6">
        <Kpi label="Registered voters" value={compact(numbers.registered)} note={numbers.pvcRate != null ? `${compact(numbers.registered - numbers.pvcUncollected)} collected their PVC (${pct(numbers.pvcRate, 1)})` : "voter register"} />
        <Kpi label="PVC not collected" value={num(numbers.pvcUncollected)} note={numbers.pvcRate != null ? `${pct(1 - numbers.pvcRate, 1)} of the register` : ""} />
        <Kpi lead label="APC members" value={num(numbers.members)} note={numbers.members != null && numbers.registered ? `${pct(numbers.members / numbers.registered, 1)} of registered voters` : ""} />
        <Kpi label="Polling units reached" value={num(numbers.pollingUnitsReached)} note={numbers.pollingUnitsReached != null ? `${num(Math.max(numbers.pollingUnits - numbers.pollingUnitsReached, 0))} polling units remaining · of ${num(numbers.pollingUnits)}` : ""} />
        <Kpi label="10x PU promoters" value={tenx.connected ? num(tenx.promoters) : "—"}
          note={tenx.connected ? `${pct(tenx.promoters / tenx.target, 1)} of ${compact(tenx.target)} target · in ${num(tenx.pollingUnits)} PUs · ${tenx.apcOverlapLoaded && tenx.apc10xPromoters != null ? `${num(tenx.apc10xPromoters)} match supplied APC list` : "APC matching unavailable"}` : "10x not connected yet"}
          meter={tenx.connected ? tenx.promoters / tenx.target : null} />
        <Kpi label="Community projects" value={projects?.wards != null ? `${num(projects.wards)} / ${projects.wardsTotal}` : "—"}
          note={projects ? `wards covered · ${num(projects.total)} projects` : "from 10x, none shared yet"}
          meter={projects?.wards != null ? projects.wards / projects.wardsTotal : null} />
      </div>

      <div className="pv-row pv-main4">
        <Card title="Voter intention poll" sub={intention ? `${num(intention.responses)} people surveyed` : "no survey yet"}>
          {intention ? (
            <>
              <div className="pv-donut">
                <Donut split={intention.split} />
                <ul className="pv-list">
                  {intention.split.map((item) => <li key={item.id}><span><i style={{ background: POLL_COLORS[item.id] }} />{item.label}</span><b>{pct(item.share)}</b></li>)}
                </ul>
              </div>
            </>
          ) : <p className="pv-empty">Load the survey in Manage data.</p>}
        </Card>

        <Card title="Weakest polling-unit coverage" sub="LGAs with the smallest share of polling units that have an APC member">
          {coverage.length ? (
            <table className="pv-cov">
              <thead><tr><th>#</th><th>LGA</th><th>Coverage</th><th>Units</th><th aria-label="Bar" /></tr></thead>
              <tbody>
                {coverage.map((row, index) => (
                  <tr key={row.key}>
                    <td>{index + 1}</td>
                    <td><button type="button" onClick={() => onOpenLga?.({ key: row.key, name: row.name })} title="Open on the Insight map">{row.name}</button></td>
                    <td>{pct(row.share)}</td>
                    <td>{num(row.covered)}/{num(row.units)}</td>
                    <td><em><u style={{ width: `${row.share * 100}%`, background: STATUS_COLORS[row.status] }} /></em></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="pv-empty">Load the APC member list to see coverage.</p>}
          <p className="pv-note">Red under 90% · amber 90–95% · green 95% and above. Click an LGA to open it on the map.</p>
        </Card>

        <Card title="Community projects" sub={projects ? `${projects.lgas} LGAs · ${num(projects.wards)} wards · ${num(projects.total)} projects` : "Shared by 10x"}>
          {projects?.stages ? (
            <>
              <div className="pv-stages">
                {STAGES.map((stage) => <div key={stage.id}><b>{num(projects.stages[stage.id])}</b><span><i style={{ background: stage.color }} />{stage.label}</span></div>)}
              </div>
              {stageTotal > 0 && (
                <div className="pv-stack" aria-hidden="true">
                  {STAGES.map((stage) => <i key={stage.id} style={{ width: `${(projects.stages[stage.id] / stageTotal) * 100}%`, background: stage.color }} />)}
                </div>
              )}
              {projects.partial && <p className="pv-note">10x sent only part of its project list; totals may be low.</p>}
            </>
          ) : (
            <p className="pv-empty pv-empty-left">{tenx.connected ? "10x has not shared any community projects yet." : "Projects appear here once 10x is connected: submitted, ongoing, completed and not started, by ward."}</p>
          )}
        </Card>

        <Card title="5 critical intelligence" sub="From the call center, 10x, the survey and online">
          <ol className="pv-alerts">
            {intelligence.map((item) => <li key={item.id} className={item.tone}><b>{item.title}</b><p>{item.text}</p></li>)}
          </ol>
        </Card>
      </div>

      {online && <Online online={online} />}
    </section>
  );
}
