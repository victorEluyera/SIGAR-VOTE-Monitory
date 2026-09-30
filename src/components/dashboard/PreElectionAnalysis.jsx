import { useState } from "react";
import SentimentMapTab from "./SentimentMapTab.jsx";
import OverviewTab from "./OverviewTab.jsx";
import FeedbackAnalysisTab from "./FeedbackAnalysisTab.jsx";
import ResourcesTab from "./ResourcesTab.jsx";

/**
 * Pre-election: four tabs.
 *   Overview  -- the summary for the candidate and stakeholders.
 *   Insight   -- the map.
 *   Sentiment -- what people tell us: call center, 10x field work, online, the feedback form.
 *   Resources -- plans, resources and reports (administrators).
 * Uploads live in the sidebar under Tools -> Manage Data.
 */
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "insight", label: "Insight" },
  { id: "feedback", label: "Sentiment" },
  { id: "resources", label: "Resources", admin: true },
];

export default function PreElectionAnalysis({ authToken, canAdmin = false }) {
  const [tab, setTab] = useState("overview");
  const [mapLga, setMapLga] = useState(null);
  const openOnMap = (lga) => { setMapLga(lga); setTab("insight"); };

  return (
    <section className="pre-election-dashboard">
      <div className="rc-tab-bar pre-election-tabs">
        {TABS.filter((item) => !item.admin || canAdmin).map((item) => (
          <button key={item.id} className={tab === item.id ? "rc-tab active" : "rc-tab"} onClick={() => { if (item.id === "insight") setMapLga(null); setTab(item.id); }}>
            {item.label}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab authToken={authToken} onOpenLga={openOnMap} />}
      {tab === "insight" && <SentimentMapTab key={mapLga?.key || "all"} authToken={authToken} initialLga={mapLga} />}
      {tab === "feedback" && <FeedbackAnalysisTab authToken={authToken} />}
      {tab === "resources" && canAdmin && <ResourcesTab authToken={authToken} />}
    </section>
  );
}
