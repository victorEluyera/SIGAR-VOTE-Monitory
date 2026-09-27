import { useState } from "react";
import Login from "./components/auth/Login.jsx";
import { lazy, Suspense } from "react";
import { API } from "./config.js";
import { queryClient } from "./queryClient.js";

const Dashboard = lazy(() => import("./components/dashboard/Dashboard.jsx"));
const PublicFeedbackForm = lazy(() => import("./components/feedback/PublicFeedbackForm.jsx"));
// A shared feedback link (/feedback/<token>) opens the public form: no sign-in, no dashboard.
const feedbackToken = window.location.pathname.match(/^\/feedback\/([A-Za-z0-9_-]{6,40})\/?$/)?.[1] || null;

export default function App() {
  const [session, setSession] = useState(() => {
    try {
      const stored = localStorage.getItem("command-session");
      if (stored) return JSON.parse(stored);
      const sessionStored = sessionStorage.getItem("command-session");
      return sessionStored ? JSON.parse(sessionStored) : null;
    } catch {
      return null;
    }
  });

  const login = (value, rememberMe = true) => {
    const sessionValue = JSON.stringify(value);
    const storage = rememberMe ? localStorage : sessionStorage;
    const staleStorage = rememberMe ? sessionStorage : localStorage;
    storage.setItem("command-session", sessionValue);
    staleStorage.removeItem("command-session");
    setSession(value);
  };

  const logout = () => {
    fetch(`${API}/auth/logout`, {
      method: "POST",
      credentials: "same-origin",
    }).catch(() => {});
    localStorage.removeItem("command-session");
    sessionStorage.removeItem("command-session");
    queryClient.clear();
    setSession(null);
  };

  const updateSession = (value) => {
    const next = { token: value.token, user: value.user };
    if (localStorage.getItem("command-session")) {
      localStorage.setItem("command-session", JSON.stringify(next));
    } else {
      sessionStorage.setItem("command-session", JSON.stringify(next));
    }
    setSession(next);
  };
  if (feedbackToken) {
    return (
      <Suspense fallback={<div className="grid min-h-screen place-content-center text-sm">Loading…</div>}>
        <PublicFeedbackForm token={feedbackToken} />
      </Suspense>
    );
  }
  return session ? (
    <Suspense
      fallback={
        <div
          className="grid min-h-screen place-content-center justify-items-center gap-3.5 bg-[#1b050d] text-[#f5dc9a]"
          role="status"
        >
          <span className="size-[34px] animate-spin rounded-full border-[3px] border-[#8b1e46] border-t-[#ecc86f]"></span>
          <b className="font-[Arial,sans-serif] text-xs font-semibold tracking-[0.08em]">
            Loading command center…
          </b>
        </div>
      }
    >
      <Dashboard
        session={session}
        onLogout={logout}
        onSessionUpdate={updateSession}
      />
    </Suspense>
  ) : (
    <Login onLogin={login} />
  );
}
