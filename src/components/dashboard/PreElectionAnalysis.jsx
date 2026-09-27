import { useState } from "react";
import AreaOperations from "./AreaOperations.jsx";
import ReportingLifecycle from "./ReportingLifecycle.jsx";
import PreElectionPulse from "./PreElectionPulse.jsx";
import SentimentMapTab from "./SentimentMapTab.jsx";
import NextActionsTab from "./NextActionsTab.jsx";
import OverviewTab from "./OverviewTab.jsx";
import VoterAnalysisTab from "./VoterAnalysisTab.jsx";
import FeedbackAnalysisTab from "./FeedbackAnalysisTab.jsx";

/**
 * Pre-election: the Overview first (what a candidate or stakeholder needs to see), then Voter
 * analysis (our voters against the register, LGA -> ward -> polling unit), Feedback analysis (what
 * people tell us through the field survey, the public feedback link, the call center and 10x), Insight (the map, which
 * also carries the 2023 election history as layers), Next actions (an urgent/important matrix),
 * the Pulse, and the admin tabs. Uploads live in the sidebar under Tools -> Manage Data.
 */
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "voters", label: "Voter analysis" },
  { id: "feedback", label: "Feedback analysis" },
  { id: "map", label: "Insight" },
  { id: "actions", label: "Next actions" },
  { id: "operations", label: "Resources management", admin: true },
  { id: "pulse", label: "Pulse" },
  { id: "reports", label: "Reports", admin: true },
];

export default function PreElectionAnalysis({ authToken, canAdmin = false }) {
  const [tab, setTab] = useState("overview");
  const [mapLga, setMapLga] = useState(null);
  const openOnMap = (lga) => { setMapLga(lga); setTab("map"); };

  return (
    <section className="pre-election-dashboard">
      <div className="rc-tab-bar pre-election-tabs">
        {TABS.filter((item) => !item.admin || canAdmin).map((item) => (
          <button key={item.id} className={tab === item.id ? "rc-tab active" : "rc-tab"} onClick={() => { if (item.id === "map") setMapLga(null); setTab(item.id); }}>
            {item.label}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab authToken={authToken} onOpenLga={openOnMap} />}
      {tab === "voters" && <VoterAnalysisTab authToken={authToken} />}
      {tab === "feedback" && <FeedbackAnalysisTab authToken={authToken} />}
      {tab === "map" && <SentimentMapTab key={mapLga?.key || "all"} authToken={authToken} initialLga={mapLga} />}
      {tab === "actions" && <NextActionsTab authToken={authToken} onOpenMap={openOnMap} />}
      {tab === "operations" && canAdmin && <AreaOperations authToken={authToken} />}
      {tab === "pulse" && <PreElectionPulse authToken={authToken} />}
      {tab === "reports" && canAdmin && <ReportingLifecycle authToken={authToken} />}
    </section>
  );
}
