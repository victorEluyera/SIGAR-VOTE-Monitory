import { useQuery } from "@tanstack/react-query";
import L from "leaflet";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "../../api/client.js";
import { oyoBoundariesQuery } from "../../queries/boundaries.js";
import { wardByName, wardNumber } from "../../../shared/wardMatch.js";
import { escapeHtml, featureLgaName, lgaKey } from "../stakeholder/ui.jsx";
import { useFitHeight } from "./useFitHeight.js";
import "./sentiment-map.css";
import { createStreetLayer } from "../../mapTiles.js";

/**
 * Insight map (formerly Sentiment): tick any mix of layers (register, ground, outreach, opinion, 2023 history),
 * colour the map by one of them or by a comparison, and drill Oyo -> LGA -> ward -> polling
 * unit. Every figure comes from /api/pre-election/map; this file only draws it.
 */

const GROUPS = ["Register", "Ground", "10x", "Outreach", "Opinion", "History"];
const DEFAULT_LAYERS = ["members", "calls", "needs"];
// Faint for low values, deep for high ones: the eye reads the darkest areas as "most".
// Colours say how an area is doing without a legend: red = weak, amber = middle, green = strong,
// for every measure where more is better. The priority score runs the other way (red = needs
// attention). Measures that are neither good nor bad (age mix, registered voters) use a neutral
// blue, so a young LGA does not look like a problem.
const STRENGTH = ["#c0392b", "#e67e22", "#f2c14e", "#7cb342", "#2e7d32"];
const NEED = [...STRENGTH].reverse();
const NEUTRAL = ["#dbeafe", "#93c5fd", "#60a5fa", "#2563eb", "#1e3a8a"];
const STRENGTH_KEYS = new Set(["members", "cleaned", "cleanedPerPu", "tenx", "promoters", "promotersPerPu", "projects", "projectsPerPu", "reached", "calls", "contacts", "activePhones", "membersPerPu", "callsPer1k", "pvc", "phone", "gov2023", "pres2023", "turnout2023"]);
// Measures where more is worse (red = most).
const PROBLEM_KEYS = new Set(["duplicates"]);
const PROBLEM_WORDS = ["Clean", "Few", "Some", "Many", "Most"];
const STRENGTH_WORDS = ["Weak", "Below average", "Middle", "Good", "Strong"];
const NEED_WORDS = ["Low priority", "Some need", "Needs attention", "High need", "Top priority"];
const DIV = ["#b8452f", "#e08a6b", "#e9e1e4", "#8fcf8f", "#2f9e44"];
const NO_DATA = "#9b8f94";
// Fills dark enough to need light text on the polling-unit grid.
const DEEP = new Set([STRENGTH[0], STRENGTH[4], NEUTRAL[3], NEUTRAL[4], DIV[0], DIV[4]]);

// Basemaps: the same sources as the operations map, plus labelled imagery.
const esri = (service) => L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, attribution: "Tiles &copy; Esri" });
const BASEMAPS = {
  street: { label: "Street", layers: () => [createStreetLayer()] },
  satellite: { label: "Satellite", layers: () => [esri("World_Imagery")] },
  hybrid: { label: "Satellite + labels", layers: () => [esri("World_Imagery"), esri("Reference/World_Boundaries_and_Places")] },
  topo: { label: "Topographic", layers: () => [esri("World_Topo_Map")] },
  terrain: { label: "Terrain", layers: () => [L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxZoom: 17, attribution: "&copy; OpenTopoMap contributors" })] },
};

/** Where to write an area's name: the centroid of its largest ring (inside the shape for Oyo's LGAs and wards). */
function labelPoint(feature) {
  const geometry = feature.geometry || {};
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  let best = null;
  for (const polygon of polygons) {
    const ring = polygon[0] || [];
    let area = 0; let x = 0; let y = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      area += cross; x += (ring[j][0] + ring[i][0]) * cross; y += (ring[j][1] + ring[i][1]) * cross;
    }
    if (!area) continue;
    if (!best || Math.abs(area) > best.area) best = { area: Math.abs(area), lng: x / (3 * area), lat: y / (3 * area) };
  }
  return best ? L.latLng(best.lat, best.lng) : L.geoJSON(feature).getBounds().getCenter();
}
// INEC names are in capitals: title-case them, keeping Roman numerals (Ward III) and codes (N6A).
const titleCase = (value) => String(value || "").toLowerCase()
  .replace(/(^|[\s/(-])([a-z])/g, (match, lead, char) => lead + char.toUpperCase())
  .replace(/\b[a-z]*\d[a-z\d]*\b/gi, (code) => code.toUpperCase())
  .replace(/\b(i{1,3}|iv|vi{0,3}|ix|xi{0,2})\b/gi, (numeral) => numeral.toUpperCase());
const NEED_COLORS = { roads: "#e0a458", electricity: "#f5dc9a", water: "#5ec8ff", money: "#7fcf7f", jobs: "#c9748f", security: "#ff8a5c", health: "#b39ddb", education: "#80cbc4", agriculture: "#9ccc65", sanitation: "#a1887f" };
const SHARE_BINS = [0.2, 0.35, 0.5, 0.65];
const CHANGE_BINS = [-0.2, -0.05, 0.05, 0.25];
const LEVEL_NAMES = { lga: "LGA", ward: "Ward", pu: "Polling unit" };
// GRID3 spells some LGAs the old way; the ward service needs its spelling.
const GRID3_LGA = { "Ogbomoso North": ["Ogbomosho North"], "Ogbomoso South": ["Ogbomosho South"], Oorelope: ["Orelope"], "Ori Ire": ["Oriire", "Ori-Ire"], "Ibadan North East": ["Ibadan North-East"], "Ibadan North West": ["Ibadan North-West"], "Ibadan South West": ["Ibadan South-West"], "Ona-Ara": ["Ona Ara"], "Ogo-Oluwa": ["Ogo Oluwa"], Atisbo: ["Atigbo"] };

const num = (value) => (value == null ? "—" : Number(value).toLocaleString());
const compact = (value) => {
  if (value == null) return "—";
  const n = Number(value);
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return n.toLocaleString();
};
const pct = (value) => (value == null ? "—" : `${Math.round(value * 100)}%`);
const pts = (value) => (value == null ? "—" : `${value >= 0 ? "+" : "−"}${Math.abs(Math.round(value * 100))} pts`);
const OCCUPATION_COLORS = { trading: "#e0a458", student: "#5ec8ff", artisan: "#c9748f", business: "#f5dc9a", farming: "#9ccc65", public: "#b39ddb", homemaker: "#ff8a5c", other: "#a1887f" };
const OCCUPATION_LABELS = { trading: "Trading", student: "Students", artisan: "Artisans", business: "Business", farming: "Farming & fishing", public: "Civil & public service", homemaker: "Homemakers", other: "Other" };
// Layers read from the voter register: ticking any of them adds the register breakdown to the card.
const REGISTER_KEYS = ["registered", "women", "youth", "middleAge", "older", "occupation", "phone", "disability"];
const needLabel = (id) => ({ roads: "Roads", electricity: "Electricity", water: "Water", money: "Money", jobs: "Jobs", security: "Security", health: "Health", education: "Education", agriculture: "Agriculture", sanitation: "Sanitation" })[id] || id || "—";

function formatValue(key, value, meta) {
  if (value == null) return "—";
  if (key === "changeGov" || key === "changePres") return pts(value);
  if (key === "needs") return needLabel(value);
  if (key === "occupation") return OCCUPATION_LABELS[value] || value;
  if (key === "priority") return `${Math.round(value * 100)}/100`;
  if (key === "membersPerPu" || key === "callsPer1k" || key === "cleanedPerPu" || key === "promotersPerPu") return Number(value).toFixed(1);
  if (key === "projectsPerPu") return Number(value).toFixed(2);
  if (meta?.format === "naira" || key === "projectCostPerPu") return `₦${compact(value)}`;
  return meta?.format === "share" ? pct(value) : num(value);
}

/**
 * Colour rule for the chosen measure over the current rows: { color(value), rate(value) -> word
 * or null, legend: [{ color, label }] } so the legend always shows exactly what the map uses.
 */
function scaleFor(key, meta, rows) {
  const present = (colors, labels) => [...new Set(rows.map((row) => row.values[key]).filter(Boolean))].map((id) => ({ color: colors[id] || "#8f7d86", label: labels(id) }));
  if (key === "needs") return { color: (value) => NEED_COLORS[value] || "#8f7d86", rate: null, legend: present(NEED_COLORS, needLabel) };
  if (key === "occupation") return { color: (value) => OCCUPATION_COLORS[value] || "#8f7d86", rate: null, legend: present(OCCUPATION_COLORS, (id) => OCCUPATION_LABELS[id] || id) };
  const show = (value) => formatValue(key, meta?.format === "share" || key === "priority" || key === "changeGov" || key === "changePres" ? Math.round(value * 100) / 100 : Math.round(value), meta);
  const bands = (palette, edges, words) => palette.map((color, i) => ({
    color,
    label: `${words ? `${words[i]} · ` : ""}${i === 0 ? `under ${show(edges[0])}` : i === palette.length - 1 ? `${show(edges[i - 1])}+` : `${show(edges[i - 1])}–${show(edges[i])}`}`,
  }));
  if (key === "changeGov" || key === "changePres") {
    const step = (value) => { const i = CHANGE_BINS.findIndex((edge) => value < edge); return i === -1 ? 4 : i; };
    return { color: (value) => DIV[step(value)], rate: null, legend: bands(DIV, CHANGE_BINS, null) };
  }
  const palette = key === "priority" || PROBLEM_KEYS.has(key) ? NEED : STRENGTH_KEYS.has(key) ? STRENGTH : NEUTRAL;
  const words = key === "priority" ? NEED_WORDS : PROBLEM_KEYS.has(key) ? PROBLEM_WORDS : STRENGTH_KEYS.has(key) ? STRENGTH_WORDS : null;
  const scaled = (edges) => {
    const step = (value) => { const i = edges.findIndex((edge) => value < edge); return i === -1 ? 4 : i; };
    return { color: (value) => palette[step(value)], rate: words ? (value) => words[step(value)] : null, legend: bands(palette, edges, words) };
  };
  // 2023 vote shares keep fixed bands, so 50%+ always reads as won.
  if (key === "gov2023" || key === "pres2023") return scaled(SHARE_BINS);
  // Everything else is ranked against the areas on screen: the top fifth is "Strong" here.
  const values = rows.map((row) => row.values[key]).filter((value) => value != null && Number.isFinite(value)).sort((a, b) => a - b);
  if (!values.length) return { color: () => NO_DATA, rate: null, legend: [] };
  // Every area has the same value (e.g. no members in any ward yet): one colour, no ranking.
  if (values[0] === values[values.length - 1]) {
    const color = words && values[0] === 0 ? palette[0] : palette[2];
    return { color: () => color, rate: null, legend: [{ color, label: `All ${show(values[0])}` }] };
  }
  return scaled([0.2, 0.4, 0.6, 0.8].map((q) => values[Math.min(values.length - 1, Math.floor(q * values.length))]));
}

/** What the colours and circles on the map mean. */
function Legend({ title, scale, dotLabel, hasNoData, top = false }) {
  if (!scale?.legend?.length) return null;
  return (
    <div className={`smp-legend${top ? " smp-legend-top" : ""}`} aria-label="Map legend">
      <b>{title}</b>
      <div>
        {scale.legend.map((item) => <span key={item.label}><i style={{ background: item.color }} />{item.label}</span>)}
        {hasNoData && <span><i className="smp-hatch" />No data</span>}
      </div>
      {dotLabel && <span className="smp-dotnote"><i />Circles: {dotLabel.toLowerCase()} (bigger = more)</span>}
    </div>
  );
}

async function fetchWardBoundaries(lgaName, token, signal) {
  for (const name of [lgaName, ...(GRID3_LGA[lgaName] || [])]) {
    const data = await apiRequest(`/boundaries/oyo/wards?lga=${encodeURIComponent(name)}`, token, { signal }).catch(() => null);
    if (data?.wards?.features?.length) return data;
  }
  return { wards: { features: [] } };
}

/** Who is on the register here: age bands, women, main occupations, phone on file, disability. */
function RegisterBlock({ register }) {
  const peak = Math.max(...register.ages.map((band) => band.share || 0), 0.01);
  return (
    <div className="smp-register">
      <span>Voter register · {num(register.voters)} voters</span>
      <div className="smp-register-row">
        <b>Age</b>
        <div className="smp-register-bars">
          {register.ages.map((band) => (
            <i key={band.label} title={`${band.label}: ${pct(band.share)}`}>
              <strong>{pct(band.share)}</strong>
              <em><u style={{ height: `${Math.max(Math.round(((band.share || 0) / peak) * 100), 3)}%` }} /></em>
              <small>{band.label}</small>
            </i>
          ))}
        </div>
      </div>
      <div className="smp-register-row"><b>Women</b><p>{pct(register.women)} · men {pct(register.women == null ? null : 1 - register.women)}</p></div>
      <div className="smp-register-row"><b>Occupation</b><p>{register.occupations.filter((item) => item.id !== "other").slice(0, 4).map((item) => `${item.label} ${pct(item.share)}`).join(" · ")}</p></div>
      <div className="smp-register-row"><b>Phone on file</b><p>{pct(register.phone)}{register.disability ? ` · ${num(register.disability)} with a disability` : ""}</p></div>
    </div>
  );
}

function AreaCard({ area, data, selected, measure, onOpen }) {
  const { level, layers, context } = data;
  if (!area) return null;
  const v = area.values;
  const d = area.detail || {};
  // Inside an LGA the card starts on that LGA (the context row) until a ward is picked.
  const kind = area === context ? "lga" : level;
  // History rows get their own line with the winner, so they are not repeated as bare shares.
  const rows = [...new Set([measure, ...selected])].filter((key) => key && key !== "needs" && key !== "occupation" && v[key] !== undefined && !(key === "gov2023" && d.gov2023) && !(key === "pres2023" && d.pres2023));
  const labelOf = (key) => layers[key]?.label || data.comparisons[key]?.label || (key === "priority" ? "Priority score" : key);
  return (
    <section className="smp-card">
      <header>
        <div>
          <h3>{area.number && kind === "pu" ? `PU ${String(area.number).padStart(3, "0")} · ` : ""}{area.name}</h3>
          <p>{kind === "lga" ? `LGA · ${num(area.wards)} wards · ${num(area.pollingUnits)} polling units` : kind === "ward" ? `Ward ${area.number} · ${num(area.pollingUnits)} polling units` : `${area.code || ""}${d.accredited ? ` · ${num(d.accredited)} accredited in 2023` : ""}`}</p>
        </div>
        {onOpen && <button type="button" className="smp-open" onClick={onOpen}>{level === "lga" ? "Open wards →" : "Open polling units →"}</button>}
      </header>
      <dl>
        {rows.map((key) => (
          <div key={key}><dt>{labelOf(key)}{key === "population" && d.populationEstimated ? " (est.)" : ""}</dt><dd>{formatValue(key, v[key], layers[key])}{key === "reached" && area.pollingUnits ? ` · ${area.unitsWithMember}/${area.pollingUnits}` : ""}</dd></div>
        ))}
        {d.gov2023 && selected.includes("gov2023") && <div><dt>2023 Governorship</dt><dd>{d.gov2023.winner} won · APC {pct(d.gov2023.apc)} · PDP {pct(d.gov2023.pdp)}</dd></div>}
        {d.pres2023 && selected.includes("pres2023") && <div><dt>2023 Presidential</dt><dd>{d.pres2023.winner} won · APC {pct(d.pres2023.apc)}{d.pres2023.parties ? ` · PDP ${pct(d.pres2023.pdp)}` : ""}</dd></div>}
        {d.survey && selected.includes("undecided") && <div><dt>Survey</dt><dd>{num(d.survey.responses)} answers{d.survey.leader ? ` · ${d.survey.leader.split(" ").slice(-1)[0]} leads` : ""}</dd></div>}
      </dl>
      {selected.includes("needs") && d.needs?.length > 0 && (
        <div className="smp-needs">
          <span>Needs (survey + callers)</span>
          {d.needs.slice(0, 4).map((need) => <i key={need.id} style={{ borderColor: NEED_COLORS[need.id] }} title={`Survey ${need.survey == null ? "—" : pct(need.survey)} · callers ${need.callers}`}>{need.label}<b>{need.survey != null ? ` ${pct(need.survey)}` : ""}{need.callers ? ` · ${need.callers} call${need.callers === 1 ? "" : "s"}` : ""}</b></i>)}
        </div>
      )}
      {d.register && selected.some((key) => REGISTER_KEYS.includes(key)) && <RegisterBlock register={d.register} />}
      {kind !== "lga" && context?.detail.needs?.length > 0 && (
        <p className="smp-context">{context.name} (LGA): top needs {context.detail.needs.slice(0, 2).map((need) => need.label.toLowerCase()).join(", ")}</p>
      )}
    </section>
  );
}

const SEVERITY = { high: "High", medium: "Medium", low: "Low" };

/** The alerts for the level on screen, most serious first; four show until "View all". */
function AlertsCard({ alerts }) {
  const [all, setAll] = useState(false);
  if (!alerts?.length) return null;
  const shown = all ? alerts : alerts.slice(0, 4);
  return (
    <section className="smp-card smp-alerts" aria-label="Critical alerts">
      <header>
        <h3><span className="smp-alert-mark" aria-hidden="true">!</span>Critical alerts <span className="smp-count">{alerts.length}</span></h3>
        {alerts.length > 4 && <button type="button" className="smp-link" onClick={() => setAll((value) => !value)}>{all ? "Show fewer" : "View all →"}</button>}
      </header>
      <ul>
        {shown.map((alert) => (
          <li key={alert.title} className={alert.severity}>
            <i aria-hidden="true">{alert.severity === "low" ? "i" : "!"}</i>
            <div><b>{alert.title}</b><small>{alert.detail}</small></div>
            <em>{SEVERITY[alert.severity]}</em>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One layer group as a Power BI-style slicer: a dropdown of tick boxes. */
function LayerSlicer({ group, layers, selected, level, badges, open, onOpen, onToggle, onClear }) {
  const items = Object.entries(layers).filter(([, layer]) => layer.group === group);
  if (!items.length) return null;
  const on = items.filter(([key]) => selected.includes(key));
  return (
    <div className={`smp-slicer${open ? " open" : ""}`}>
      <button type="button" className={`smp-slicer-btn${on.length ? " has" : ""}`} aria-expanded={open} aria-haspopup="true" onClick={onOpen}>
        <span>{group}</span>
        <b>{on.length ? (on.length === 1 ? on[0][1].label : `${on.length} selected`) : "None"}</b>
        <i aria-hidden="true">▾</i>
      </button>
      {open && (
        <div className="smp-slicer-menu">
          {items.map(([key, layer]) => {
            const off = !layer.loaded;
            const here = layer.levels.includes(level);
            const why = off ? layer.hint || "Not loaded yet: upload it in Tools → Manage Data" : !here ? `Shown at ${layer.levels.map((item) => LEVEL_NAMES[item]).join(" / ")} level` : layer.note || "";
            return (
              <label key={key} className={`${off ? "off" : ""}${!here ? " dim" : ""}`} title={why}>
                <input type="checkbox" checked={selected.includes(key)} disabled={off} onChange={() => onToggle(key)} />
                <span>{layer.label}{off && <small>{why}</small>}</span>
                <em>{off ? (layer.source === "oyo10x" ? "10x" : layer.source === "ncc" ? "NCC" : "upload") : badges[key] || ""}</em>
              </label>
            );
          })}
          {on.length > 0 && <button type="button" className="smp-slicer-clear" onClick={onClear}>Clear {group.toLowerCase()}</button>}
        </div>
      )}
    </div>
  );
}

export default function SentimentMapTab({ authToken, initialLga = null }) {
  const [lga, setLga] = useState(initialLga); // { key, name }
  const [ward, setWard] = useState(null); // { number, name }
  const [selected, setSelected] = useState(DEFAULT_LAYERS);
  const [colourBy, setColourBy] = useState("membersPerPu");
  const [view, setView] = useState("layers");
  const [openGroup, setOpenGroup] = useState(null); // which layer slicer is open
  const slicersRef = useRef(null);
  useEffect(() => {
    if (!openGroup) return undefined;
    const close = (event) => { if (event.type === "keydown" ? event.key === "Escape" : !slicersRef.current?.contains(event.target)) setOpenGroup(null); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [openGroup]);
  // The area whose figures show on the right: set by a click, cleared when the level changes.
  const [picked, setPicked] = useState(null);
  const [basemap, setBasemap] = useState(() => { try { return localStorage.getItem("smp-basemap") || "street"; } catch { return "street"; } });
  const tileRef = useRef(null);
  const [fitRef, fitHeight] = useFitHeight();
  const mapNode = useRef(null);
  const mapRef = useRef(null);

  const query = useQuery({
    queryKey: ["pre-election-map", lga?.key || "", ward?.number || ""],
    queryFn: ({ signal }) => apiRequest(`/pre-election/map?lga=${encodeURIComponent(lga?.key || "")}&ward=${ward?.number || ""}`, authToken, { signal }),
    placeholderData: (previous) => previous,
    staleTime: 30_000,
  });
  const lgaBoundaries = useQuery(oyoBoundariesQuery);
  const wardBoundaries = useQuery({
    queryKey: ["pre-election-map-wards", lga?.name],
    queryFn: ({ signal }) => fetchWardBoundaries(lga.name, authToken, signal),
    enabled: !!lga,
    staleTime: 86_400_000,
  });

  const data = query.data;
  const level = data?.level || "lga";
  const rows = data?.rows || [];
  const measure = view === "priority" ? "priority" : colourBy;
  const measureMeta = data?.layers?.[measure];
  const scale = useMemo(() => (data ? scaleFor(measure, measureMeta, rows) : null), [data, measure, measureMeta, rows]);

  // Colour-by options: ticked layers usable at this level, plus comparisons whose inputs are ticked.
  const colourOptions = useMemo(() => {
    if (!data) return [];
    const layerOptions = selected.filter((key) => data.layers[key]?.levels.includes(level)).map((key) => ({ key, label: data.layers[key].label }));
    const comparisons = Object.entries(data.comparisons).filter(([, item]) => item.needs.every((need) => selected.includes(need) || need === "registered")).map(([key, item]) => ({ key, label: item.label }));
    return [...comparisons, ...layerOptions];
  }, [data, selected, level]);
  useEffect(() => {
    if (colourOptions.length && !colourOptions.some((option) => option.key === colourBy)) setColourBy(colourOptions[0].key);
  }, [colourOptions, colourBy]);

  // Second measure drawn as circles: the first ticked count layer that is not the colour.
  const dotKey = useMemo(() => selected.find((key) => key !== measure && data?.layers[key]?.format === "count" && data.layers[key].levels.includes(level) && level !== "pu"), [selected, measure, data, level]);

  // Boundary features for the current level, matched to rows.
  const features = useMemo(() => {
    if (level === "lga") {
      const byKey = new Map(rows.map((row) => [lgaKey(row.name), row]));
      return (lgaBoundaries.data?.lgas?.features || []).map((feature) => ({ feature, row: byKey.get(lgaKey(featureLgaName(feature))) }));
    }
    const wardFeatures = wardBoundaries.data?.wards?.features || [];
    const wardRows = level === "ward" ? rows : [];
    const names = (level === "ward" ? rows : [{ name: data?.ward?.name }]).map((row) => row.name).filter(Boolean);
    const byName = new Map(wardRows.map((row) => [row.name, row]));
    const byNumber = new Map((data?.options?.wards || []).map((item) => [item.number, item.name]));
    const matched = new Set();
    const items = wardFeatures.map((feature) => {
      const p = feature.properties || {};
      const labels = [p.ward, ...String(p.ward_alt_names || "").split(/[;,|]/)].map((name) => String(name || "").trim()).filter(Boolean);
      // GRID3 often names Ibadan wards by area and keeps the INEC number in another name
      // ("Agbowo Ward 12"), so the number is the fallback.
      let match = labels.map((name) => wardByName(name, names)).find(Boolean);
      if (!match) match = byNumber.get(labels.map((name) => wardNumber(name)).find(Boolean)) || "";
      if (match && !names.includes(match)) match = "";
      if (match) matched.add(match);
      return { feature, row: level === "ward" ? byName.get(match) : null, current: level === "pu" && match === data?.ward?.name };
    }).filter((item) => level === "ward" || item.current);
    items.matchedNames = matched;
    return items;
  }, [level, rows, lgaBoundaries.data, wardBoundaries.data, data]);

  // Wards the boundary map could not place (GRID3 and INEC name them differently): shown as tiles.
  const unplacedRows = useMemo(() => (level === "ward" && wardBoundaries.isFetched ? rows.filter((row) => !features.matchedNames?.has(row.name)) : []), [level, rows, features, wardBoundaries.isFetched]);

  const drill = (row) => {
    if (!row) return;
    setPicked(null);
    if (level === "lga") setLga({ key: row.key, name: row.name });
    else if (level === "ward") setWard({ number: row.number, name: row.name });
  };
  const goTo = (target) => {
    setPicked(null);
    if (target === "lga") { setLga(null); setWard(null); }
    if (target === "ward" && lga) setWard(null);
  };

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return;
    // Double-click opens an area (see below), so it must not also zoom the map.
    const map = L.map(mapNode.current, { zoomControl: true, scrollWheelZoom: true, zoomSnap: 0.25, doubleClickZoom: false }).setView([8.1, 3.6], 8);
    mapRef.current = map;
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(mapNode.current);
    return () => { observer.disconnect(); map.remove(); mapRef.current = null; };
    // The map container only exists once the first data has arrived.
  }, [Boolean(query.data)]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    tileRef.current?.remove();
    tileRef.current = L.layerGroup((BASEMAPS[basemap] || BASEMAPS.street).layers()).addTo(map);
    tileRef.current.eachLayer((layer) => layer.bringToBack());
    try { localStorage.setItem("smp-basemap", basemap); } catch { /* private mode: not remembered */ }
  }, [basemap, Boolean(query.data)]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !data || !scale) return undefined;
    const group = L.featureGroup().addTo(map);
    const dotMax = dotKey ? Math.max(...rows.map((row) => row.values[dotKey] || 0), 1) : 1;
    const shapes = L.geoJSON({ type: "FeatureCollection", features: features.map((item) => item.feature) }, {
      style: (feature) => {
        const item = features.find((entry) => entry.feature === feature);
        const value = item?.row?.values[measure];
        return {
          color: item?.current ? "#ffffff" : "#16040a",
          weight: item?.current ? 3 : 1.2,
          fillColor: level === "pu" ? "#d9aa4b" : value == null ? NO_DATA : scale.color(value),
          fillOpacity: level === "pu" ? 0.18 : 0.72,
          dashArray: value == null && level !== "pu" ? "4 3" : null,
        };
      },
      onEachFeature: (feature, layer) => {
        const item = features.find((entry) => entry.feature === feature);
        const row = item?.row;
        const name = row?.name || feature.properties?.ward || featureLgaName(feature) || "Area";
        const rating = row && scale.rate && row.values[measure] != null ? scale.rate(row.values[measure]) : "";
        const lines = row ? [...new Set([measure, ...selected])].filter((key) => row.values[key] !== undefined).slice(0, 6).map((key) => `${escapeHtml(data.layers[key]?.label || data.comparisons[key]?.label || "Priority")}: <b>${escapeHtml(formatValue(key, row.values[key], data.layers[key]))}</b>${key === measure && rating ? ` · <b>${escapeHtml(rating)}</b>` : ""}`) : ["No data matched to this boundary"];
        layer.bindTooltip(`<b>${escapeHtml(name)}</b><br>${lines.join("<br>")}${row ? `<br><i>Click for details${level !== "pu" ? ` · double-click to open ${level === "lga" ? "its wards" : "its polling units"}` : ""}</i>` : ""}`, { sticky: true, className: "smp-tip" });
        if (row) {
          layer.on("add", () => layer.getElement()?.setAttribute("data-area", row.key));
          layer.on("click", () => setPicked(row));
          layer.on("dblclick", () => drill(row));
        }
      },
    }).addTo(group);
    if (dotKey) {
      for (const item of features) {
        if (!item.row) continue;
        const value = item.row.values[dotKey];
        const center = labelPoint(item.feature); // the name sits just below the circle
        if (value == null) continue;
        if (!value) {
          L.circleMarker(center, { radius: 5, color: "#ff8a5c", weight: 2, fillOpacity: 0 }).bindTooltip(`${escapeHtml(item.row.name)}: no ${escapeHtml(data.layers[dotKey].label.toLowerCase())}`).addTo(group);
          continue;
        }
        L.circleMarker(center, { radius: 4 + Math.sqrt(value / dotMax) * 16, color: "#0b2a3a", weight: 1, fillColor: "#5ec8ff", fillOpacity: 0.75 })
          .bindTooltip(`${escapeHtml(item.row.name)}: ${escapeHtml(formatValue(dotKey, value, data.layers[dotKey]))} ${escapeHtml(data.layers[dotKey].label.toLowerCase())}`)
          .on("click", () => setPicked(item.row))
          .on("dblclick", () => drill(item.row))
          .addTo(group);
      }
    }
    // Names on every area; a name is hidden while its area is too small on screen to hold it,
    // and appears as you zoom in.
    const labels = features.map((item) => {
      const raw = item.row?.name || item.feature.properties?.ward || featureLgaName(item.feature);
      if (!raw) return null;
      const text = level === "lga" ? raw : titleCase(raw);
      const marker = L.marker(labelPoint(item.feature), {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({ className: `smp-label${level === "lga" ? " smp-label-lga" : ""}`, html: `<span>${escapeHtml(text)}</span>`, iconSize: null }),
      }).addTo(group);
      return { marker, bounds: L.geoJSON(item.feature).getBounds(), width: text.length * (level === "lga" ? 6.6 : 6) + 10 };
    }).filter(Boolean);
    const placeLabels = () => {
      for (const label of labels) {
        const a = map.latLngToContainerPoint(label.bounds.getNorthWest());
        const b = map.latLngToContainerPoint(label.bounds.getSouthEast());
        const fits = Math.abs(b.x - a.x) >= label.width * 0.8 && Math.abs(b.y - a.y) >= 16;
        const element = label.marker.getElement();
        if (element) element.style.visibility = fits ? "visible" : "hidden";
      }
    };
    map.on("zoomend", placeLabels);
    const bounds = shapes.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [16, 16] });
    placeLabels();
    return () => { map.off("zoomend", placeLabels); group.remove(); };
    // drill/setPicked are stable enough for this effect; re-running on them would refit the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, features, scale, measure, selected, dotKey, level]);

  if (query.isError) return <section className="smp" ref={fitRef}><p className="smp-empty">{query.error.message}</p></section>;
  if (!data) return <section className="smp" ref={fitRef}><p className="smp-empty">Loading the insight map…</p></section>;

  const toggle = (key) => setSelected((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));
  const totals = data.totals;
  const pillValue = { population: "est.", registered: compact(totals.registered), members: compact(totals.members), cleaned: totals.cleaned != null ? compact(totals.cleaned) : null, duplicates: totals.duplicates != null ? compact(totals.duplicates) : null, promoters: totals.promoters != null ? compact(totals.promoters) : null, tenx: totals.tenx != null ? compact(totals.tenx) : null, contacts: compact(totals.contacts), calls: compact(totals.calls) };
  const pickLga = (key) => {
    setPicked(null);
    setWard(null);
    const option = data.options?.lgas.find((item) => item.key === key);
    setLga(option ? { key: option.key, name: option.name } : null);
  };
  const pickWard = (number) => {
    setPicked(null);
    const option = data.options?.wards.find((item) => String(item.number) === number);
    setWard(option ? { number: option.number, name: option.name } : null);
  };
  // Always the latest figures for the picked area (a refetch replaces the row objects).
  const pickedRow = picked ? rows.find((row) => row.key === picked.key) || null : null;
  const card = pickedRow || (level === "ward" ? data.context : null);
  const boundaryMissing = level === "lga" ? lgaBoundaries.isError || !lgaBoundaries.data?.lgas : level === "pu" && wardBoundaries.isFetched && !features.length;

  return (
    <section ref={fitRef} style={fitHeight ? { height: fitHeight } : undefined} className={`smp${query.isFetching ? " smp-busy" : ""}`} aria-label="Insight map">
      <div className="smp-bar">
        <nav className="smp-crumb" aria-label="Map level">
          <button type="button" onClick={() => goTo("lga")} className={level === "lga" ? "on" : ""}>Oyo State</button>
          {lga && <><span>›</span><button type="button" onClick={() => goTo("ward")} className={level === "ward" ? "on" : ""}>{lga.name}</button></>}
          {ward && <><span>›</span><b>{data.ward?.name || ward.name}</b></>}
          <small>{level === "lga" ? "click an LGA for details · double-click to open its wards" : level === "ward" ? "click a ward for details · double-click to open its polling units" : "click a polling unit for details"}</small>
        </nav>
        <div className="smp-controls">
          <label className="smp-field">LGA
            <select value={lga?.key || ""} onChange={(event) => pickLga(event.target.value)}>
              <option value="">All 33 LGAs</option>
              {(data.options?.lgas || []).map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}
            </select>
          </label>
          <label className="smp-field">Ward
            <select value={ward ? String(ward.number) : ""} onChange={(event) => pickWard(event.target.value)} disabled={!lga}>
              <option value="">{lga ? "All wards" : "Pick an LGA first"}</option>
              {(data.options?.wards || []).map((item) => <option key={item.number} value={String(item.number)}>{titleCase(item.name)}</option>)}
            </select>
          </label>
          <label className="smp-field">Colour by
            <select value={view === "priority" ? "" : colourBy} onChange={(event) => { setView("layers"); setColourBy(event.target.value); }} disabled={view === "priority"}>
              {colourOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
            </select>
          </label>
          <div className="smp-seg" role="group" aria-label="View">
            <button type="button" className={view === "layers" ? "on" : ""} onClick={() => setView("layers")}>Layers</button>
            <button type="button" className={view === "priority" ? "on" : ""} onClick={() => setView("priority")}>Priority score</button>
          </div>
        </div>
      </div>

      <div className="smp-slicers" ref={slicersRef} role="group" aria-label="Map layers">
        <span className="smp-slicers-title">Layers</span>
        {GROUPS.map((group) => (
          <LayerSlicer
            key={group}
            group={group}
            layers={data.layers}
            selected={selected}
            level={level}
            badges={pillValue}
            open={openGroup === group}
            onOpen={() => setOpenGroup((current) => (current === group ? null : group))}
            onToggle={toggle}
            onClear={() => setSelected((current) => current.filter((key) => data.layers[key]?.group !== group))}
          />
        ))}
        <button type="button" className="smp-reset" onClick={() => { setSelected(DEFAULT_LAYERS); setOpenGroup(null); }}>Reset</button>
      </div>

      <div className="smp-main">
        <div className="smp-map-wrap">
          <div ref={mapNode} className="smp-map" aria-label="Oyo map" />
          <label className="smp-basemap">
            <span>Map</span>
            <select value={basemap} onChange={(event) => setBasemap(event.target.value)} aria-label="Map style">
              {Object.entries(BASEMAPS).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}
            </select>
          </label>
          <Legend title={view === "priority" ? "Priority score" : colourOptions.find((option) => option.key === colourBy)?.label} scale={scale} dotLabel={dotKey ? data.layers[dotKey]?.label : null} hasNoData={features.some((item) => !item.row) || rows.some((row) => row.values[measure] == null)} top={level === "pu" || unplacedRows.length > 0} />
          {unplacedRows.length > 0 && (
            <div className="smp-units smp-unplaced">
              <b>{unplacedRows.length === rows.length ? `The boundary map names every ward in ${lga?.name} differently from INEC, so they are shown here` : `${unplacedRows.length} ward${unplacedRows.length === 1 ? "" : "s"} with no matching boundary on the map`} · click for details, double-click to open</b>
              <div>
                {unplacedRows.map((row) => {
                  const value = row.values[measure];
                  const fill = value == null ? NO_DATA : scale.color(value);
                  return (
                    <button key={row.key} type="button" onClick={() => setPicked(row)} onDoubleClick={() => drill(row)} aria-pressed={pickedRow?.key === row.key} className={pickedRow?.key === row.key ? "picked" : ""} style={{ background: fill, color: DEEP.has(fill) ? "#f7eff2" : "#2b0816" }} title={`${titleCase(row.name)} · ${formatValue(measure, value, measureMeta)}`}>
                      {titleCase(row.name)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {boundaryMissing && <p className="smp-overlay-note">Boundaries for this level could not be loaded. The side panel and polling-unit grid still work.</p>}
          {level === "pu" && (
            <div className="smp-units">
              <b>Polling units in {data.ward?.name} ({rows.length}) · coloured by {colourOptions.find((option) => option.key === colourBy)?.label?.toLowerCase() || "members"}</b>
              <div>
                {rows.map((row) => {
                  const value = row.values[measure];
                  const fill = value == null ? NO_DATA : scale.color(value);
                  const dark = DEEP.has(fill);
                  return (
                    <button key={row.key} type="button" onClick={() => setPicked(row)} aria-pressed={pickedRow?.key === row.key} style={{ background: fill, color: dark ? "#f7eff2" : "#2b0816" }} className={`${!row.values.members ? "none" : ""}${pickedRow?.key === row.key ? " picked" : ""}`} title={`${row.name} · ${formatValue(measure, value, measureMeta)}`}>
                      {String(row.number).padStart(3, "0")}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <aside className="smp-side">
          {card ? <AreaCard area={card} data={data} selected={selected} measure={measure} onOpen={level !== "pu" && card !== data.context ? () => drill(card) : null} />
            : <section className="smp-card"><header><div><h3>{level === "lga" ? "All 33 LGAs" : data.ward?.name}</h3><p>Click an area to see its figures</p></div></header>
              <dl>
                <div><dt>Registered voters</dt><dd>{num(level === "lga" ? totals.registered : data.ward?.registered)}</dd></div>
                {level === "lga" && <><div><dt>APC confirmed members</dt><dd>{num(totals.members)}</dd></div><div><dt>10x volunteers</dt><dd>{totals.tenx != null ? num(totals.tenx) : "oyo10x not connected"}</dd></div><div><dt>Contacts in our possession</dt><dd>{num(totals.contacts)}</dd></div><div><dt>Call center calls</dt><dd>{num(totals.calls)}</dd></div></>}
              </dl>
              {level === "pu" && data.ward?.register && selected.some((key) => REGISTER_KEYS.includes(key)) && <RegisterBlock register={data.ward.register} />}
              </section>}
          <AlertsCard key={`${level}|${lga?.key || ""}|${ward?.number || ""}`} alerts={data.alerts} />
          <section className="smp-card">
            <h3>Where to act</h3>
            <p className="smp-sub">{level === "pu" ? "Units that most need a member" : "Ranked by the priority score"}</p>
            {data.ranking.length ? (
              <ol className="smp-rank">
                {data.ranking.map((item, index) => {
                  const row = rows.find((entry) => entry.key === item.key);
                  return (
                    <li key={item.key}>
                      <button type="button" onClick={() => row && setPicked(row)} onDoubleClick={() => level !== "pu" && drill(row)} title={level === "pu" ? "Click for details" : "Click for details · double-click to open"}>
                        <i>{index + 1}</i><span>{level === "pu" ? `PU ${String(item.number).padStart(3, "0")} ${item.name}` : item.name}</span><b>{item.reasons.join(" · ")}</b>
                      </button>
                    </li>
                  );
                })}
              </ol>
            ) : <p className="smp-sub">Nothing stands out at this level.</p>}
          </section>
          <section className="smp-card smp-intel">
            <h3>Map intelligence</h3>
            <p className="smp-sub">{level === "lga" ? "History + survey + ground work" : level === "ward" ? `${data.lga?.name} · wards` : `${data.ward?.name} · polling units`}</p>
            <ol>{data.insights.map((item, index) => <li key={index} className={item.tone}><span>{{ risk: "Act", watch: "Watch", good: "Strength", info: "Insight" }[item.tone]}</span><p>{item.text}</p></li>)}</ol>
            <p className="smp-source">2023 results: {data.sources.history}</p>
          </section>
        </aside>
      </div>
    </section>
  );
}
