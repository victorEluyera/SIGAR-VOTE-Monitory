import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { apiRequest } from "../../api/client.js";
import { LgaMap, lgaKey } from "../stakeholder/ui.jsx";
import "../stakeholder/stakeholder.css";
import { useFitHeight } from "./useFitHeight.js";
import "./pre-election-views.css";

/**
 * Overview: where the party stands, for the candidate and stakeholders. One sentence, five
 * numbers, every LGA in a band, and the few things to act on. Figures come from
 * /api/pre-election/overview, built from the same data as the Pulse and the Insight map.
 */

// Same meaning as the Insight map: green strong, amber contested, red weak.
const STANDING_COLORS = { strong: "#2e7d32", leaning: "#7cb342", battleground: "#f2c14e", weak: "#c0392b", nodata: "#6b5a60" };
const INTENTION_COLORS = { us: "#2e7d32", others: "#c0392b", none: "#8f7d86" };

const num = (value) => (value == null ? "—" : Number(value).toLocaleString());
const pct = (value, digits = 0) => (value == null ? "—" : `${(value * 100).toFixed(digits)}%`);
const compact = (value) => (value == null ? "—" : value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : Number(value).toLocaleString());

function Card({ title, sub, className = "", children }) {
  return (
    <section className={`pv-card ${className}`}>
      <header><h3>{title}</h3>{sub && <p>{sub}</p>}</header>
      {children}
    </section>
  );
}

function StandingMap({ standing }) {
  const rowsByKey = useMemo(() => new Map(standing.flatMap((band) => band.lgas.map((lga) => [lgaKey(lga.key), { ...lga, band: band.id, bandLabel: band.label }]))), [standing]);
  const fill = useCallback((row) => STANDING_COLORS[row?.band] || STANDING_COLORS.nodata, []);
  const tooltip = useCallback((name, row) => `<b>${name}</b><br>${row ? `${row.bandLabel}${row.share != null ? ` · Sen. Alli ${pct(row.share)}` : ""}` : "No data"}`, []);
  return <LgaMap rowsByKey={rowsByKey} fill={fill} tooltip={tooltip} />;
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

  const { intention, numbers, standing, requests, platforms, callCenter, watch } = data;
  const counted = standing.filter((band) => band.id !== "nodata");

  return (
    <section ref={fitRef} style={fitHeight ? { height: fitHeight } : undefined} className="pv" aria-label="Overview">
      <div className="pv-headline">
        <p className="pv-headline-title">
          {intention
            ? <>Sen. Alli is the first choice of <b>{pct(intention.share)}</b> of voters surveyed who named a candidate.</>
            : "No voter survey has been loaded yet."}
        </p>
        {intention && <p className="pv-headline-sub">{num(intention.responses)} people surveyed{intention.weightedShare != null ? ` · ${pct(intention.weightedShare)} when each LGA counts by its registered voters` : ""} · strongest in {standing.find((band) => band.id === "strong")?.lgas.slice(0, 3).map((lga) => lga.name).join(", ") || "—"}</p>}
      </div>

      <div className="pv-kpis">
        <div className="pv-kpi"><span>Registered voters</span><strong>{compact(numbers.registered)}</strong><small>{numbers.pvcRate != null ? `${pct(numbers.pvcRate)} collected their PVC` : "voter register"}</small></div>
        <div className="pv-kpi"><span>APC confirmed members</span><strong>{num(numbers.members)}</strong><small>{numbers.members != null && numbers.registered ? `${pct(numbers.members / numbers.registered, 1)} of registered voters` : ""}</small></div>
        <div className="pv-kpi"><span>Polling units reached</span><strong>{num(numbers.pollingUnitsReached)}</strong><small>of {num(numbers.pollingUnits)}{numbers.pollingUnitsReached != null ? ` · ${pct(numbers.pollingUnitsReached / numbers.pollingUnits)}` : ""}</small></div>
        <div className="pv-kpi"><span>LGAs reached</span><strong>{numbers.lgasReached != null ? `${numbers.lgasReached} of ${numbers.lgas}` : "—"}</strong><small>with APC confirmed members</small></div>
        <div className="pv-kpi"><span>10x volunteers</span><strong>{numbers.tenx != null ? num(numbers.tenx) : "—"}</strong><small>{numbers.tenxConnected ? "live from oyo10x" : "oyo10x not connected"}</small></div>
      </div>

      <div className="pv-main">
        <Card title="Where the party stands" sub="Each LGA by Sen. Alli's survey share. Click an LGA name to open it on the Insight map." className="pv-standing">
          <div className="pv-standing-body">
            <div className="pv-standing-map"><StandingMap standing={standing} /></div>
            <ul className="pv-bands">
              {standing.map((band) => (
                <li key={band.id}>
                  <b style={{ color: STANDING_COLORS[band.id] === "#6b5a60" ? undefined : STANDING_COLORS[band.id] }}><i style={{ background: STANDING_COLORS[band.id] }} />{band.label} · {band.lgas.length}</b>
                  <div>
                    {band.lgas.map((lga) => (
                      <button key={lga.key} type="button" onClick={() => onOpenLga?.({ key: lga.key, name: lga.name })} title="Open on the Insight map">
                        {lga.name}{lga.share != null ? ` ${pct(lga.share)}` : ""}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <p className="pv-note">{counted.reduce((sum, band) => sum + band.lgas.length, 0)} LGAs have enough survey answers to place. Strong 50%+ · Leaning 35–50% · Battleground 20–35% · Weak under 20%.</p>
        </Card>

        <div className="pv-side">
          <Card title="Vote intention" sub={intention ? `${num(intention.responses)} people surveyed` : "no survey yet"}>
            {intention ? (
              <>
                <div className="pv-stack" role="img" aria-label={intention.split.map((item) => `${item.label} ${pct(item.share)}`).join(", ")}>
                  {intention.split.map((item) => <i key={item.id} style={{ width: `${item.share * 100}%`, background: INTENTION_COLORS[item.id] }} />)}
                </div>
                <ul className="pv-list">
                  {intention.split.map((item) => <li key={item.id}><span><i style={{ background: INTENTION_COLORS[item.id] }} />{item.label}</span><b>{pct(item.share)}</b></li>)}
                </ul>
              </>
            ) : <p className="pv-empty">Load the survey in Manage data.</p>}
          </Card>

          <Card title="What voters are requesting" sub="Survey top issues and what callers ask for">
            <div className="pv-two">
              <ul className="pv-list">{requests.survey.map((item) => <li key={item.name}><span>{item.name}</span><b>{pct(item.share)}</b></li>)}</ul>
              <ul className="pv-list">{requests.callers.map((item) => <li key={item.name}><span>{item.name}</span><b>{num(item.calls)} calls</b></li>)}</ul>
            </div>
          </Card>

          <Card title="Most influential platform" sub="Where voters form their views">
            <ul className="pv-bars">
              {platforms.map((item, index) => (
                <li key={item.name}><span>{item.name}</span><em><u style={{ width: `${(item.share / (platforms[0]?.share || 1)) * 100}%`, opacity: 1 - index * 0.18 }} /></em><b>{pct(item.share)}</b></li>
              ))}
            </ul>
          </Card>

          <Card title="Call center feedback" sub={callCenter ? callCenter.period : "no report loaded"}>
            {callCenter ? (
              <ul className="pv-list">
                <li><span>Calls · people reached</span><b>{num(callCenter.calls)} · {num(callCenter.people)}</b></li>
                <li><span>Callers who support us</span><b>{pct(callCenter.supporters?.share)}</b></li>
                <li><span>Still open · asked for call back</span><b>{num(callCenter.open)} · {num(callCenter.followUp)}</b></li>
                <li><span>LGAs · wards called</span><b>{num(callCenter.lgasCalled)} · {num(callCenter.wardsReached)}</b></li>
              </ul>
            ) : <p className="pv-empty">Load the contact center report in Manage data.</p>}
          </Card>
        </div>
      </div>

      {watch.length > 0 && (
        <Card title="Watch this week" className="pv-watch">
          <ul>{watch.map((item) => <li key={item.text} className={item.tone}>{item.text}</li>)}</ul>
        </Card>
      )}
    </section>
  );
}
