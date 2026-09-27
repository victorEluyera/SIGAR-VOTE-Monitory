import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { apiRequest } from "../../api/client.js";
import { useFitHeight } from "./useFitHeight.js";
import "./pre-election-views.css";

/**
 * Voter analysis: of the registered voters in each LGA, ward and polling unit, how many are ours
 * (APC confirmed members + 10x volunteers not already members), who those voters are (register
 * profile) and where to act. Click a row to open the next level.
 */

const STATUS_COLORS = { strong: "#2e7d32", good: "#7cb342", thin: "#f2c14e", veryThin: "#e67e22", none: "#c0392b" };
const OCCUPATIONS = { trading: "Trading", student: "Students", artisan: "Artisans", business: "Business", farming: "Farming", public: "Public service", homemaker: "Homemakers", other: "Other" };
const LEVEL_WORD = { lga: "LGA", ward: "Ward", pu: "Polling unit" };
const LEVEL_PLURAL = { lga: "LGAs", ward: "wards", pu: "polling units" };
const FIND = { lga: "Find an LGA", ward: "Find a ward", pu: "Find a polling unit" };
const TENX_NOTE = {
  checked: "Counted only if not already an APC member",
  "totals-only": "Not yet checked against APC members",
  "not-connected": "oyo10x not connected",
  "no-member-keys": "Cannot be checked against APC members yet",
};

const num = (value) => (value == null ? "—" : Number(value).toLocaleString());
const pct = (value, digits = 0) => (value == null ? "—" : `${(value * 100).toFixed(digits)}%`);
const compact = (value) => (value == null ? "—" : value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : Number(value).toLocaleString());

const COLUMNS = [
  { key: "name", label: "Area", sort: (row) => row.name },
  { key: "registered", label: "Registered", num: true },
  { key: "apc", label: "APC members", num: true },
  { key: "tenx", label: "10x", num: true },
  { key: "ours", label: "Our voters", num: true },
  { key: "reach", label: "Share of register", num: true },
  { key: "women", label: "Women", num: true },
  { key: "youth", label: "18–34", num: true },
  { key: "phone", label: "Phone on file", num: true },
  { key: "occupation", label: "Main occupation", sort: (row) => OCCUPATIONS[row.occupation] || "" },
  { key: "pres2023", label: "APC 2023", num: true },
];

export default function VoterAnalysisTab({ authToken }) {
  const [lga, setLga] = useState(null); // { key, name }
  const [ward, setWard] = useState(null); // { number, name }
  const [sort, setSort] = useState({ key: "registered", dir: -1 });
  const [search, setSearch] = useState("");
  const [fitRef, fitHeight] = useFitHeight();

  const query = useQuery({
    queryKey: ["pre-election-voters", lga?.key || "", ward?.number || ""],
    queryFn: ({ signal }) => apiRequest(`/pre-election/voters?lga=${encodeURIComponent(lga?.key || "")}&ward=${ward?.number || ""}`, authToken, { signal }),
    placeholderData: (previous) => previous,
    staleTime: 30_000,
  });
  const data = query.data;

  const rows = useMemo(() => {
    if (!data) return [];
    const column = COLUMNS.find((item) => item.key === sort.key);
    const value = column?.sort || ((row) => row[sort.key]);
    const needle = search.trim().toLowerCase();
    return data.rows
      .filter((row) => !needle || row.name.toLowerCase().includes(needle) || String(row.number ?? "").includes(needle))
      .sort((a, b) => {
        const x = value(a); const y = value(b);
        if (x == null) return 1;
        if (y == null) return -1;
        return (typeof x === "string" ? x.localeCompare(y) : x - y) * sort.dir;
      });
  }, [data, sort, search]);

  if (query.isError && !data) return <section className="pv" ref={fitRef}><p className="pv-empty">{query.error.message}</p></section>;
  if (!data) return <section className="pv" ref={fitRef}><p className="pv-empty">Loading the voter analysis…</p></section>;

  const s = data.summary;
  const level = data.level;
  const open = (row) => {
    setSearch("");
    if (level === "lga") setLga({ key: row.key, name: row.name });
    else if (level === "ward") setWard({ number: row.number, name: row.name });
  };
  const toggleSort = (key) => setSort((current) => ({ key, dir: current.key === key ? -current.dir : key === "name" || key === "occupation" ? 1 : -1 }));
  const statusMax = Math.max(...s.status.map((item) => item.areas), 1);

  return (
    <section ref={fitRef} style={fitHeight ? { height: fitHeight } : undefined} className={`pv${query.isFetching ? " pv-busy" : ""}`} aria-label="Voter analysis">
      <div className="pv-bar">
        <nav className="pv-crumb" aria-label="Level">
          <button type="button" className={level === "lga" ? "on" : ""} onClick={() => { setLga(null); setWard(null); }}>Oyo State</button>
          {lga && <><span>›</span><button type="button" className={level === "ward" ? "on" : ""} onClick={() => setWard(null)}>{lga.name}</button></>}
          {ward && <><span>›</span><b>{data.ward?.name || ward.name}</b></>}
          <small>{level === "pu" ? "polling units of this ward" : `click a ${level === "lga" ? "LGA" : "ward"} to open it`}</small>
        </nav>
        <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={FIND[level]} aria-label={FIND[level]} />
      </div>

      <div className="pv-kpis">
        <div className="pv-kpi"><span>Registered voters</span><strong>{compact(s.registered)}</strong><small>{num(s.areas)} {LEVEL_PLURAL[level]} in {s.place}</small></div>
        <div className="pv-kpi"><span>APC confirmed members</span><strong>{num(s.apc)}</strong><small>{pct(s.registered ? s.apc / s.registered : null, 1)} of registered voters</small></div>
        <div className="pv-kpi"><span>10x volunteers</span><strong>{s.tenxStatus === "checked" ? num(s.tenxUnique) : num(s.tenx)}</strong><small>{s.tenxStatus === "checked" && s.tenxAlreadyMembers ? `${num(s.tenxAlreadyMembers)} already APC members` : TENX_NOTE[s.tenxStatus]}</small></div>
        <div className="pv-kpi pv-kpi-lead"><span>Our voters</span><strong>{num(s.ours)}</strong><small>APC members{s.tenxStatus === "checked" ? " + new 10x volunteers" : ""}</small></div>
        <div className="pv-kpi pv-kpi-lead"><span>Share of register</span><strong>{pct(s.reach, 1)}</strong><small>our voters ÷ registered voters</small></div>
      </div>

      <div className="pv-status" role="group" aria-label={`${LEVEL_PLURAL[level]} by share of register`}>
        {s.status.map((item) => (
          <div key={item.id} title={`${item.label}: ${item.areas}`}>
            <span><i style={{ background: STATUS_COLORS[item.id] }} />{item.label}</span>
            <em><u style={{ width: `${(item.areas / statusMax) * 100}%`, background: STATUS_COLORS[item.id] }} /></em>
            <b>{item.areas}</b>
          </div>
        ))}
        <p>Strong 10%+ of voters are ours · Good 5–10% · Thin 2–5% · Very thin under 2%</p>
      </div>

      <div className="pv-voters">
        <div className="pv-table-wrap">
          <table className="pv-table">
            <thead>
              <tr>
                {COLUMNS.map((column) => (
                  <th key={column.key} className={column.num ? "num" : ""} aria-sort={sort.key === column.key ? (sort.dir > 0 ? "ascending" : "descending") : "none"}>
                    <button type="button" onClick={() => toggleSort(column.key)}>{column.key === "name" ? LEVEL_WORD[level] : column.label}{sort.key === column.key ? (sort.dir > 0 ? " ↑" : " ↓") : ""}</button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} onClick={() => level !== "pu" && open(row)} className={level !== "pu" ? "pv-link" : ""} title={level !== "pu" ? `Open ${row.name}` : undefined}>
                  <th scope="row">{level === "pu" ? `${String(row.number).padStart(3, "0")} ` : ""}{row.name}</th>
                  <td className="num">{num(row.registered)}</td>
                  <td className="num">{num(row.apc)}</td>
                  <td className="num">{s.tenxStatus === "checked" ? num(row.tenxUnique) : num(row.tenx)}</td>
                  <td className="num"><b>{num(row.ours)}</b></td>
                  <td className="num">
                    <span className="pv-reach"><i style={{ width: `${Math.min((row.reach || 0) / 0.15, 1) * 100}%`, background: STATUS_COLORS[row.status] || "#6b5a60" }} /></span>
                    {pct(row.reach, 1)}
                  </td>
                  <td className="num">{pct(row.women)}</td>
                  <td className="num">{pct(row.youth)}</td>
                  <td className="num">{pct(row.phone)}</td>
                  <td>{OCCUPATIONS[row.occupation] || "—"}</td>
                  <td className="num">{pct(row.pres2023)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <aside className="pv-side">
          <section className="pv-card">
            <header><h3>Voter intelligence</h3><p>{s.place} · {LEVEL_WORD[level].toLowerCase()} level</p></header>
            <ol className="pv-intel">{data.insights.map((item) => <li key={item.text} className={item.tone}>{item.text}</li>)}</ol>
          </section>
          <section className="pv-card">
            <header><h3>Who is registered here</h3><p>From the voter register</p></header>
            <ul className="pv-list">
              <li><span>Women</span><b>{pct(s.profile.women)}</b></li>
              <li><span>Aged 18–34</span><b>{pct(s.profile.youth)}</b></li>
              <li><span>Aged 55 and over</span><b>{pct(s.profile.older)}</b></li>
              <li><span>Phone number on file</span><b>{pct(s.profile.phone)}</b></li>
            </ul>
          </section>
        </aside>
      </div>
    </section>
  );
}
