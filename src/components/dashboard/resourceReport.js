/**
 * The campaign report: one set of sections built from the dashboard's own figures, written out as
 * a printable page (saved as PDF from the print dialog), a spreadsheet (CSV, opens in Excel) or a
 * PowerPoint deck. The preview on the Reports view is built from the same sections, so what you
 * see is what you download.
 */

const num = (value) => (value == null ? "—" : Number(value).toLocaleString("en-US"));
const pct = (value, digits = 0) => (value == null ? "—" : `${(value * 100).toFixed(digits)}%`);

// ---- Recommended resources ---------------------------------------------------------------------

/**
 * What a campaign of this size needs, from simple rules per polling unit, ward and LGA. `scope`:
 * { lgas, wards, pollingUnits, registered, stateRegistered, promoterTarget, state }.
 */
export function recommendResources(scope) {
  const { lgas, wards, pollingUnits: pus, registered, stateRegistered, promoterTarget, state } = scope;
  const vehicles = 2 * lgas;
  const promoters = registered && stateRegistered ? Math.round((promoterTarget * registered) / stateRegistered) : null;
  return [
    {
      module: "People",
      rows: [
        { name: "LGA coordinators", value: lgas, basis: "1 per LGA" },
        { name: "Ward coordinators", value: wards, basis: "1 per ward" },
        { name: "Supervisors", value: Math.ceil(pus / 10), basis: "1 per 10 polling units" },
        { name: "Polling-unit agents", value: pus * 2, basis: "1 agent + 1 reserve per polling unit" },
        { name: "Collation agents", value: wards + lgas + (state ? 1 : 0), basis: "1 per ward, LGA and state collation centre" },
        { name: "10x unit promoters", value: promoters, basis: `Share of the ${num(promoterTarget)} target by registered voters` },
        { name: "Drivers", value: vehicles, basis: "1 per vehicle" },
      ],
    },
    {
      module: "Electoral data",
      rows: [
        ...(state ? [
          { name: "Senatorial districts", value: 3, basis: "Oyo Central, North, South" },
          { name: "Federal constituencies", value: 14, basis: "INEC" },
          { name: "State constituencies", value: 32, basis: "INEC" },
        ] : []),
        { name: "LGAs", value: lgas, basis: "INEC" },
        { name: "Wards", value: wards, basis: "INEC" },
        { name: "Polling units", value: pus, basis: "INEC" },
        { name: "Registered voters", value: registered, basis: "Voter register" },
      ],
    },
    {
      module: "Logistics",
      rows: [
        { name: "Campaign offices", value: lgas, basis: "1 per LGA" },
        ...(state ? [
          { name: "Command / situation centre", value: 1, basis: "State-wide" },
          { name: "Contact centre", value: 1, basis: "State-wide" },
        ] : []),
        { name: "Vehicles", value: vehicles, basis: "2 per LGA", recorded: "Vehicle" },
        { name: "Motorcycles", value: wards, basis: "1 per ward" },
        { name: "PA systems", value: lgas, basis: "1 per LGA" },
        { name: "Fuel (litres a day)", value: vehicles * 20, basis: "20 litres per vehicle per campaign day", recorded: "Fuel" },
      ],
    },
  ];
}

// ---- Report ------------------------------------------------------------------------------------

export function buildReport({ projectName, title, place, overview, feedback, resources, plans }) {
  const sections = [];
  const n = overview?.numbers;
  if (n) {
    sections.push({
      title: "Headline numbers",
      note: "State-wide",
      table: [
        ["Registered voters", num(n.registered)],
        ["PVCs uncollected", num(n.pvcUncollected)],
        ["APC members", num(n.members)],
        ["Polling units reached", `${num(n.pollingUnitsReached)} of ${num(n.pollingUnits)}`],
        ["10x PU promoters", overview.tenx?.connected ? num(overview.tenx.promoters) : "10x not connected"],
      ],
    });
  }
  if (overview?.intention) {
    sections.push({
      title: "Voter intention poll",
      note: `${num(overview.intention.responses)} people surveyed`,
      table: [
        ...overview.intention.split.map((item) => [item.label, pct(item.share)]),
        ["Sen. Alli among people who named a candidate", pct(overview.intention.share, 1)],
      ],
    });
  }
  if (overview?.coverage?.length) {
    sections.push({
      title: "Weakest polling-unit coverage",
      header: ["LGA", "Coverage", "Polling units reached"],
      table: overview.coverage.slice(0, 8).map((row) => [row.name, pct(row.share), `${num(row.covered)} of ${num(row.units)}`]),
    });
  }
  if (feedback?.channels?.critical?.length) {
    sections.push({ title: "Critical intelligence", note: place, bullets: feedback.channels.critical.map((item) => `${item.source}: ${item.text}`) });
  }
  const callCenter = feedback?.channels?.callCenter;
  if (callCenter?.available) {
    sections.push({
      title: "Call center",
      note: callCenter.period,
      table: [
        ["Calls", num(callCenter.calls)],
        ["People reached", num(callCenter.people)],
        ...(callCenter.supporters ? [["Supporters", pct(callCenter.supporters.share)]] : []),
        ...(callCenter.open != null ? [["Still open", num(callCenter.open)], ["Asked for a follow-up", num(callCenter.followUp)]] : []),
        ...callCenter.detail.themes.slice(0, 5).map((row) => [`Raised: ${row.label}`, num(row.calls)]),
      ],
    });
  }
  const field = feedback?.channels?.field;
  if (field?.available) {
    sections.push({
      title: "10x field work",
      note: `${num(field.responses)} field answers`,
      table: [
        ["Sen. Alli, of named choices", pct(field.focusShare)],
        ["Not decided", pct(field.undecided)],
        ...field.topIssues.map((row) => [`Top issue: ${row.name}`, pct(row.share)]),
      ],
    });
  }
  const online = feedback?.channels?.online;
  if (online?.available) {
    sections.push({
      title: "Online conversation",
      note: online.period.label,
      table: [
        ["Mentions (Sen. Alli)", num(online.totals.mentions.us)],
        ["Positive · neutral · negative", `${online.sentiment.us.positive}% · ${online.sentiment.us.neutral}% · ${online.sentiment.us.negative}%`],
        ["Main feeling", `Anger ${online.emotion.us.anger}%`],
      ],
      bullets: online.feedback.map((item) => item.text),
    });
  }
  if (resources?.length) {
    sections.push({
      title: "Resources",
      note: place,
      header: ["Resource", "Requested", "Available", "Allocated", "Arrived", "Missing"],
      table: resources.map((row) => [row.resourceType, num(row.required), num(row.available), num(row.deployed), num(row.arrived), num(row.missing)]),
    });
  }
  if (plans?.length) {
    sections.push({
      title: "Plans",
      note: place,
      header: ["Date", "Plan", "Type", "Area"],
      table: plans.slice(0, 20).map((plan) => [plan.date, plan.title, plan.category, [plan.lga, plan.ward].filter(Boolean).join(" · ")]),
    });
  }
  return { projectName: projectName || "Sen. Sharafadeen Alli campaign", title: title || "Campaign situation report", place, generatedAt: new Date(), sections };
}

const slug = (report) => `${report.title}-${report.place}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "report";
const stamp = (report) => report.generatedAt.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function download(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A clean printable page in a new window; the browser's print dialog saves it as PDF. */
export function printReport(report) {
  const win = window.open("", "_blank", "width=900,height=1000");
  if (!win) throw new Error("Allow pop-ups for this site to create the PDF.");
  const sections = report.sections.map((section) => `
    <section>
      <h2>${escapeHtml(section.title)}${section.note ? ` <small>${escapeHtml(section.note)}</small>` : ""}</h2>
      ${section.table ? `<table>${section.header ? `<thead><tr>${section.header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead>` : ""}<tbody>${section.table.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>` : ""}
      ${section.bullets ? `<ul>${section.bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
    </section>`).join("");
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(report.title)}</title>
    <style>
      body { font: 12.5px/1.45 "Segoe UI", system-ui, sans-serif; color: #1f1116; margin: 32px; }
      header { border-bottom: 3px solid #7a1f3d; padding-bottom: 10px; margin-bottom: 18px; }
      header p { margin: 0; color: #7a1f3d; font-size: 11px; letter-spacing: .1em; text-transform: uppercase; }
      h1 { margin: 4px 0; font-size: 22px; } header span { color: #6b5a60; }
      h2 { font-size: 14px; margin: 18px 0 6px; color: #7a1f3d; } h2 small { font-weight: 400; color: #6b5a60; }
      table { width: 100%; border-collapse: collapse; } th, td { padding: 4px 8px; border-bottom: 1px solid #e6dde0; text-align: left; }
      th { background: #f5eef0; font-weight: 600; } td:not(:first-child) { font-variant-numeric: tabular-nums; }
      ul { margin: 6px 0 0; padding-left: 18px; } li { margin-bottom: 3px; }
      section { break-inside: avoid; }
    </style></head><body>
    <header><p>${escapeHtml(report.projectName)}</p><h1>${escapeHtml(report.title)}</h1><span>${escapeHtml(report.place)} · ${escapeHtml(stamp(report))}</span></header>
    ${sections}
    </body></html>`);
  win.document.close();
  // Printed from here, not by a script in the page, so a strict content policy cannot block it.
  win.focus();
  setTimeout(() => win.print(), 300);
}

/** Every section as rows of a CSV file, which Excel opens directly. */
export function downloadExcel(report) {
  const cell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const lines = [[report.projectName], [report.title], [`${report.place} · ${stamp(report)}`], []];
  for (const section of report.sections) {
    lines.push([section.title, section.note || ""]);
    if (section.header) lines.push(section.header);
    for (const row of section.table || []) lines.push(row);
    for (const item of section.bullets || []) lines.push(["", item]);
    lines.push([]);
  }
  // The byte-order mark makes Excel read the file as UTF-8 (₦, –, ·).
  download(`${slug(report)}.csv`, new Blob(["﻿", lines.map((line) => line.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
}

/** A deck: a title slide, then one slide per section. The library loads only when asked for. */
export async function downloadPowerPoint(report) {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const deck = new PptxGenJS();
  deck.layout = "LAYOUT_WIDE";
  const maroon = "5A1530";
  const gold = "D9AA4B";
  const cover = deck.addSlide();
  cover.background = { color: "220912" };
  cover.addText(report.projectName.toUpperCase(), { x: 0.6, y: 1.6, w: 12, fontSize: 14, color: gold, bold: true, charSpacing: 2 });
  cover.addText(report.title, { x: 0.6, y: 2.1, w: 12, fontSize: 36, color: "FFFFFF", bold: true });
  cover.addText(`${report.place} · ${stamp(report)}`, { x: 0.6, y: 3.2, w: 12, fontSize: 16, color: "CFA7B3" });
  for (const section of report.sections) {
    const slide = deck.addSlide();
    slide.addShape(deck.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.9, fill: { color: maroon } });
    slide.addText(section.title, { x: 0.5, y: 0.15, w: 9, h: 0.6, fontSize: 24, bold: true, color: "FFFFFF" });
    if (section.note) slide.addText(section.note, { x: 8.5, y: 0.2, w: 4.4, h: 0.5, fontSize: 12, color: gold, align: "right" });
    let y = 1.2;
    if (section.table?.length) {
      const rows = [...(section.header ? [section.header.map((text) => ({ text, options: { bold: true, fill: { color: "F5EEF0" } } }))] : []), ...section.table.slice(0, section.bullets ? 4 : 12)];
      slide.addTable(rows, { x: 0.5, y, w: 12.3, fontSize: 13, color: "1F1116", border: { type: "solid", color: "E6DDE0", pt: 0.5 }, rowH: 0.36 });
      y += 0.4 * rows.length + 0.3;
    }
    if (section.bullets?.length) {
      slide.addText(section.bullets.slice(0, 7).map((text) => ({ text, options: { bullet: true, breakLine: true } })), { x: 0.5, y, w: 12.3, h: Math.max(7.2 - y, 1), fontSize: 14, color: "1F1116", valign: "top", paraSpaceAfter: 6 });
    }
  }
  await deck.writeFile({ fileName: `${slug(report)}.pptx` });
}
