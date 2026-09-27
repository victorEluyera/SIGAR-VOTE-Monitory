import { useEffect, useState } from "react";
import { apiRequest } from "../../api/client.js";
import "./feedback-form.css";

/**
 * The feedback form (the campaign's Core Field Questionnaire), opened from a shared link
 * (/feedback/<token>). No sign-in needed and anonymous for the public; a field agent who is signed
 * in on this phone is credited automatically. Every choice is a dropdown.
 */

const sentKey = (token) => `feedback-sent:${token}`;
const alreadySent = (token) => { try { return Boolean(localStorage.getItem(sentKey(token))); } catch { return false; } };
/** The signed-in field agent on this phone, if any (question 18 is filled from it). */
const signedIn = () => {
  try {
    const raw = localStorage.getItem("command-session") || sessionStorage.getItem("command-session");
    const session = raw ? JSON.parse(raw) : null;
    return session?.token ? session : null;
  } catch { return null; }
};

function Select({ id, label, number, options, value, onChange, required = false, placeholder = "Choose an answer" }) {
  return (
    <label className="ff-q" htmlFor={`q-${id}`}>
      <span className="ff-label">{number && <b>{number}.</b>} {label}{required && <span className="ff-req" aria-label="required"> *</span>}</span>
      <select id={`q-${id}`} value={value || ""} onChange={(event) => onChange(event.target.value)} required={required}>
        <option value="">{placeholder}</option>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

export default function PublicFeedbackForm({ token }) {
  const session = signedIn();
  const [state, setState] = useState({ status: "loading" });
  const [answers, setAnswers] = useState({});
  const [place, setPlace] = useState({ lga: "", ward: "", unit: "" });
  const [places, setPlaces] = useState({ wards: [], units: [], projects: [] });
  const [ratings, setRatings] = useState({});
  const [facility, setFacility] = useState({ type: "", note: "", lat: null, lng: null, accuracy: null });
  const [locating, setLocating] = useState("");
  const [website, setWebsite] = useState(""); // hidden from people; bots fill it
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    apiRequest(`/public/feedback/${encodeURIComponent(token)}`, null)
      .then((data) => {
        setState({ status: "ready", form: data.form, started: data.started });
        if (data.form.lga) setPlace((current) => ({ ...current, lga: data.form.lga.key }));
      })
      .catch((failure) => setState({ status: "error", message: failure.message }));
  }, [token]);

  useEffect(() => {
    if (!place.lga) return;
    apiRequest(`/public/feedback/${encodeURIComponent(token)}/places?lga=${encodeURIComponent(place.lga)}&ward=${place.ward}`, null)
      .then(setPlaces)
      .catch(() => setPlaces({ wards: [], units: [], projects: [] }));
  }, [token, place.lga, place.ward]);

  if (state.status === "loading") return <main className="ff"><p className="ff-note">Loading…</p></main>;
  if (state.status === "error") return <main className="ff"><section className="ff-card"><h1>Link not available</h1><p>{state.message}</p></section></main>;
  if (state.status === "done" || (state.status === "ready" && alreadySent(token) && !session)) {
    const before = state.status !== "done";
    return (
      <main className="ff">
        <section className="ff-card ff-done">
          <h1>Thank you</h1>
          <p>{before ? "Answers have already been sent from this phone." : "Your answers have been received. They help the campaign understand what matters in your community."}</p>
          <p className="ff-note">Please share the link with others in your area.</p>
          <button type="button" className="ff-again" onClick={() => { try { localStorage.removeItem(sentKey(token)); } catch { /* nothing stored */ } window.location.reload(); }}>
            {session ? "Record another response" : "Someone else wants to answer on this phone"}
          </button>
        </section>
      </main>
    );
  }

  const { form } = state;
  const set = (id) => (value) => { setAnswers((current) => ({ ...current, [id]: value })); setError(""); };
  const bySection = (section) => form.questions.filter((question) => question.section === section);
  const locate = () => {
    if (!navigator.geolocation) return setLocating("This phone cannot share its location.");
    setLocating("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      (position) => { setFacility((current) => ({ ...current, lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy })); setLocating(""); },
      () => setLocating("Location was not shared. You can still describe the place."),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!place.lga) return setError("Choose the LGA where you are registered or expect to vote.");
    const missing = form.questions.find((question) => question.required && !answers[question.id]);
    if (missing) {
      setError(`Please answer: ${missing.text}`);
      document.getElementById(`q-${missing.id}`)?.focus();
      return;
    }
    setSending(true);
    try {
      await apiRequest(`/public/feedback/${encodeURIComponent(token)}`, session?.token || null, {
        method: "POST",
        body: JSON.stringify({
          lga: place.lga, ward: place.ward || undefined, unit: place.unit || undefined,
          answers, projects: ratings,
          facility: facility.type ? facility : undefined,
          started: state.started, website,
        }),
      });
      try { localStorage.setItem(sentKey(token), new Date().toISOString()); } catch { /* private mode: nothing remembered */ }
      setState((current) => ({ ...current, status: "done" }));
      window.scrollTo({ top: 0 });
    } catch (failure) {
      setError(failure.message);
    } finally {
      setSending(false);
    }
  };

  const questionsOf = (section) => bySection(section).map((question) => (question.type === "text" ? (
    <label className="ff-q" key={question.id} htmlFor={`q-${question.id}`}>
      <span className="ff-label"><b>{question.n}.</b> {question.text}</span>
      <textarea id={`q-${question.id}`} rows={3} maxLength={question.maxLength} value={answers[question.id] || ""} onChange={(event) => set(question.id)(event.target.value)} placeholder="A few words" />
      <small className="ff-note ff-left">Please do not include names or phone numbers.</small>
    </label>
  ) : (
    <Select key={question.id} id={question.id} number={question.n} label={question.text} options={question.options} value={answers[question.id]} onChange={set(question.id)} required={question.required} />
  )));

  return (
    <main className="ff">
      <form className="ff-card" onSubmit={submit} noValidate>
        <header className="ff-head">
          <span>Oyo State</span>
          <h1>{form.title}</h1>
          <p>{form.intro}</p>
        </header>

        <section className="ff-section"><h2>About you</h2>{questionsOf("you")}</section>

        <section className="ff-section">
          <h2>Your area</h2>
          <Select id="lga" number="2" label="In which LGA are you registered or expecting to vote?" options={form.lgas.map((lga) => lga.name)} required
            value={form.lgas.find((lga) => lga.key === place.lga)?.name}
            onChange={(name) => { if (form.lga) return; setPlace({ lga: form.lgas.find((lga) => lga.name === name)?.key || "", ward: "", unit: "" }); setRatings({}); setError(""); }} />
          <label className="ff-q" htmlFor="q-ward">
            <span className="ff-label">Ward <small>(optional)</small></span>
            <select id="q-ward" value={place.ward} disabled={!place.lga} onChange={(event) => { setPlace((current) => ({ ...current, ward: event.target.value, unit: "" })); setRatings({}); }}>
              <option value="">Choose your ward</option>
              {places.wards.map((ward) => <option key={ward.number} value={ward.number}>{ward.name}</option>)}
            </select>
          </label>
          <label className="ff-q" htmlFor="q-unit">
            <span className="ff-label">Polling unit <small>(optional)</small> · community</span>
            <select id="q-unit" value={place.unit} disabled={!place.ward} onChange={(event) => setPlace((current) => ({ ...current, unit: event.target.value }))}>
              <option value="">Choose your polling unit</option>
              {places.units.map((unit) => {
                const community = places.wards.find((ward) => ward.number === Number(place.ward))?.name || "";
                return <option key={unit.number} value={unit.number}>{String(unit.number).padStart(3, "0")} · {unit.name}{community ? ` · ${community}` : ""}</option>;
              })}
            </select>
          </label>
          {questionsOf("area")}
        </section>

        <section className="ff-section"><h2>Issues</h2>{questionsOf("issues")}</section>
        <section className="ff-section"><h2>Voting</h2>{questionsOf("voting")}</section>
        <section className="ff-section"><h2>Information</h2>{questionsOf("information")}</section>
        <section className="ff-section"><h2>Candidates</h2>{questionsOf("candidates")}</section>

        {places.projects.length > 0 && (
          <section className="ff-section">
            <h2>Projects in your area</h2>
            <p className="ff-note ff-left"><b>16.</b> Are these development projects needed in your ward? Rate each from 1 (not needed) to 10 (urgently needed).</p>
            {places.projects.map((project) => (
              <Select key={project.id} id={`p-${project.id}`} label={`${project.title}${project.candidate ? ` (${project.candidate})` : ""}`} options={Array.from({ length: 10 }, (_, i) => String(i + 1))} placeholder="Rate 1–10"
                value={ratings[project.id] ? String(ratings[project.id]) : ""} onChange={(value) => setRatings((current) => ({ ...current, [project.id]: value ? Number(value) : undefined }))} />
            ))}
          </section>
        )}

        <section className="ff-section">
          <h2>Report a facility or problem spot</h2>
          <Select id="facility" number="17" label="What facility or service needs attention?" options={form.facilityTypes} placeholder="Nothing to report"
            value={facility.type} onChange={(value) => setFacility((current) => ({ ...current, type: value }))} />
          {facility.type && (
            <>
              <label className="ff-q" htmlFor="q-facility-note">
                <span className="ff-label">Describe it and where it is</span>
                <textarea id="q-facility-note" rows={2} maxLength={200} value={facility.note} onChange={(event) => setFacility((current) => ({ ...current, note: event.target.value }))} placeholder="e.g. Broken borehole behind the central mosque" />
              </label>
              <div className="ff-geo">
                <button type="button" className="ff-again" onClick={locate}>{facility.lat != null ? "Update my location" : "Use my location for this spot"}</button>
                <small className="ff-note ff-left">{locating || (facility.lat != null ? `Location saved (${facility.lat.toFixed(5)}, ${facility.lng.toFixed(5)}${facility.accuracy ? `, within ${Math.round(facility.accuracy)} m` : ""}).` : "Only if you are standing at the spot. Your location is used only for this report.")}</small>
              </div>
            </>
          )}
        </section>

        <label className="ff-trap" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={website} onChange={(event) => setWebsite(event.target.value)} /></label>

        {error && <p className="ff-error" role="alert">{error}</p>}
        <button type="submit" className="ff-submit" disabled={sending}>{sending ? "Sending…" : "Send my answers"}</button>
        <p className="ff-note">Anonymous. Your answers are used only to plan the campaign's work in your area.</p>
      </form>
    </main>
  );
}
