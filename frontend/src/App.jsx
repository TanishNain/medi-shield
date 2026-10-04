import React, { useEffect, useMemo, useRef, useState } from "react";
import Medly from "./Medly";
import { analyzePrescription } from "./api";

const HISTORY_KEY = "medi_shield_history";

const NAV = [
  { id: "dashboard", label: "Overview", icon: "◈" },
  { id: "scanner", label: "Prescription scanner", icon: "⌕" },
  { id: "history", label: "My health records", icon: "▤" },
  { id: "diet", label: "Food & wellness", icon: "✳" },
  { id: "pharmacy", label: "Care finder", icon: "⌖" },
];

const FEATURES = [
  {
    icon: "⌕",
    title: "Prescription scan",
    desc: "Read medicine details from a prescription.",
    page: "scanner",
  },
  {
    icon: "⛨",
    title: "Safety review",
    desc: "Spot details that may need professional verification.",
    page: "scanner",
  },
  {
    icon: "✳",
    title: "Food & wellness",
    desc: "Explore general food and medicine questions.",
    page: "diet",
  },
];

function readHistory() {
  try {
    const saved = localStorage.getItem(HISTORY_KEY);
    if (!saved) return [];

    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHistory(records) {
  try {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify(records)
    );
  } catch {
    // Ignore localStorage failures.
  }
}

function getFlags(record) {
  return Array.isArray(record?.flags)
    ? record.flags
    : [];
}

function statusFor(record) {
  const flags = getFlags(record);

  if (
    flags.some(
      (flag) =>
        String(flag?.severity || "").toLowerCase() ===
        "professional_review"
    )
  ) {
    return "review";
  }

  if (flags.length) return "verify";

  return "clear";
}

function statusLabel(status) {
  if (status === "review") return "Professional review";
  if (status === "verify") return "Verify";
  return "Clear";
}

export default function App() {
  const [page, setPage] = useState("dashboard");

  const [history, setHistory] = useState(readHistory);

  const [file, setFile] = useState(null);

  const [preview, setPreview] = useState("");

  const [context, setContext] = useState("");

  const [report, setReport] = useState(null);

  const [loading, setLoading] = useState(false);

  const [error, setError] = useState("");

  const [medlyOpen, setMedlyOpen] = useState(false);

  const [mobileOpen, setMobileOpen] = useState(false);

  const [activeRecord, setActiveRecord] = useState(null);

  const inputRef = useRef(null);

  useEffect(() => {
    saveHistory(history);
  }, [history]);

  useEffect(() => {
    return () => {
      if (preview) {
        URL.revokeObjectURL(preview);
      }
    };
  }, [preview]);

  const navigate = (target) => {
    const valid = NAV.some((item) => item.id === target);

    if (!valid) return;

    setPage(target);
    setMobileOpen(false);

    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  };

  const chooseFile = (event) => {
    const selected = event.target.files?.[0];

    if (!selected) return;

    if (!selected.type.startsWith("image/")) {
      setError("Please choose an image of the prescription.");
      return;
    }

    if (preview) {
      URL.revokeObjectURL(preview);
    }

    setFile(selected);
    setPreview(URL.createObjectURL(selected));
    setReport(null);
    setError("");
  };

  const clearScanner = () => {
    if (preview) {
      URL.revokeObjectURL(preview);
    }

    setFile(null);
    setPreview("");
    setContext("");
    setReport(null);
    setError("");

    if (inputRef.current) {
      inputRef.current.value = "";
    }
  };

  const scanPrescription = async () => {
    if (!file) {
      setError("Upload a prescription image first.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const imageData = await new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => resolve(reader.result);

        reader.onerror = () =>
          reject(
            new Error("Could not read the prescription image.")
          );

        reader.readAsDataURL(file);
      });

      const result = await analyzePrescription(
        imageData,
        context
      );

      const normalized = {
        ...result,
        created_at:
          result?.created_at || new Date().toISOString(),
      };

      setReport(normalized);

      setHistory((current) => [
        normalized,
        ...current,
      ].slice(0, 30));

      setActiveRecord(null);
    } catch (requestError) {
      setError(
        requestError?.message ||
          "Prescription analysis failed."
      );
    } finally {
      setLoading(false);
    }
  };

  const openRecord = (record) => {
    setActiveRecord(record);
    setReport(record);
    setPage("history");
  };

  const currentReport = activeRecord || report;

  const medications = Array.isArray(
    currentReport?.medications
  )
    ? currentReport.medications
    : [];

  const flags = getFlags(currentReport);

  const verifyCount = useMemo(
    () =>
      history.filter(
        (item) => statusFor(item) === "verify"
      ).length,
    [history]
  );

  const reviewCount = useMemo(
    () =>
      history.filter(
        (item) => statusFor(item) === "review"
      ).length,
    [history]
  );

  const clearHistory = () => {
    if (!window.confirm("Clear all saved health records?")) {
      return;
    }

    setHistory([]);
    setActiveRecord(null);
    setReport(null);

    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {
      // Ignore.
    }
  };

  const openMedly = () => {
    setMedlyOpen(true);
  };

  const renderDashboard = () => (
    <>
      <section className="ms-hero">
        <div className="ms-hero-copy">
          <div className="ms-hero-badge">
            <span className="ms-hero-badge-dot" />
            Medication safety companion
          </div>

          <h1>
            Care that keeps you{" "}
            <span>one step ahead.</span>
          </h1>

          <p>
            Medi-Shield gives you a second pair of eyes
            for prescriptions, medicines and the questions
            you want to verify with a healthcare professional.
          </p>

          <div className="ms-hero-actions">
            <button
              type="button"
              className="ms-button ms-button-primary"
              onClick={() => navigate("scanner")}
            >
              ⌕ Scan a prescription
            </button>

            <button
              type="button"
              className="ms-button ms-button-secondary"
              onClick={openMedly}
            >
              ✦ Talk to Medly
            </button>
          </div>
        </div>

        <div className="ms-hero-visual">
          <img
            src="/medi-shield-logo.svg"
            alt="Medi-Shield"
          />
        </div>
      </section>

      <section className="ms-stat-grid">
        <div className="ms-stat-card">
          <div className="ms-stat-label">
            Reviews
          </div>

          <div className="ms-stat-value">
            {history.length}
          </div>

          <div className="ms-stat-detail">
            Saved prescription reviews
          </div>
        </div>

        <div className="ms-stat-card">
          <div className="ms-stat-label">
            Verify
          </div>

          <div className="ms-stat-value">
            {verifyCount}
          </div>

          <div className="ms-stat-detail">
            Reviews needing a closer look
          </div>
        </div>

        <div className="ms-stat-card">
          <div className="ms-stat-label">
            Professional review
          </div>

          <div className="ms-stat-value">
            {reviewCount}
          </div>

          <div className="ms-stat-detail">
            Items to discuss with a professional
          </div>
        </div>

        <div className="ms-stat-card">
          <div className="ms-stat-label">
            Companion
          </div>

          <div className="ms-stat-value">
            Medly
          </div>

          <div className="ms-stat-detail">
            Available whenever you need help
          </div>
        </div>
      </section>

      <section className="ms-section">
        <div className="ms-section-heading">
          <div>
            <h2>Your safety toolkit</h2>
            <p>
              Start with the part of Medi-Shield you need.
            </p>
          </div>
        </div>

        <div className="ms-feature-grid">
          {FEATURES.map((feature) => (
            <button
              type="button"
              key={feature.title}
              className="ms-feature-card"
              onClick={() => navigate(feature.page)}
            >
              <span className="ms-feature-icon">
                {feature.icon}
              </span>

              <h3>{feature.title}</h3>

              <p>{feature.desc}</p>

              <span className="ms-feature-link">
                Open feature →
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="ms-section ms-two-column">
        <div className="ms-panel">
          <div className="ms-panel-title">
            <h3>Recent reviews</h3>

            <button
              type="button"
              className="ms-button ms-button-secondary"
              onClick={() => navigate("history")}
            >
              View all
            </button>
          </div>

          {history.length ? (
            <div className="ms-activity-list">
              {history.slice(0, 4).map((record, index) => {
                const status = statusFor(record);

                return (
                  <button
                    type="button"
                    className="ms-activity-item"
                    key={
                      record.created_at ||
                      record.id ||
                      index
                    }
                    onClick={() => openRecord(record)}
                  >
                    <span className="ms-activity-icon">
                      ⛨
                    </span>

                    <span className="ms-activity-main">
                      <strong>
                        {record.summary ||
                          "Prescription review"}
                      </strong>

                      <span>
                        {new Date(
                          record.created_at ||
                            Date.now()
                        ).toLocaleDateString()}
                      </span>
                    </span>

                    <span
                      className={`ms-status ms-status-${status}`}
                    >
                      {statusLabel(status)}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="ms-empty">
              <div className="ms-empty-icon">▤</div>

              <h3>No reviews yet</h3>

              <p>
                Your analyzed prescriptions will appear here.
              </p>
            </div>
          )}
        </div>

        <div className="ms-panel">
          <div className="ms-panel-title">
            <h3>Need a second pair of eyes?</h3>
          </div>

          <p className="ms-page-description">
            Medly can explain medicine terminology,
            help you understand a prescription and prepare
            questions for a doctor or pharmacist.
          </p>

          <button
            type="button"
            className="ms-button ms-button-primary"
            onClick={openMedly}
          >
            Talk to Medly →
          </button>
        </div>
      </section>
    </>
  );

  const renderScanner = () => (
    <>
      <div className="ms-page-header">
        <div className="ms-page-eyebrow">
          AI-assisted review
        </div>

        <h1 className="ms-page-title">
          Prescription scanner
        </h1>

        <p className="ms-page-description">
          Upload a clear prescription image. Medi-Shield
          will extract visible medicine information and
          highlight details worth verifying.
        </p>
      </div>

      <div className="ms-scanner-layout">
        <div>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            onChange={chooseFile}
            hidden
          />

          <div
            className={`ms-dropzone ${
              file ? "has-file" : ""
            }`}
            onClick={() =>
              !file && inputRef.current?.click()
            }
          >
            {preview ? (
              <>
                <img
                  src={preview}
                  alt="Prescription preview"
                  className="ms-file-preview"
                />

                <div className="ms-scanner-actions">
                  <button
                    type="button"
                    className="ms-button ms-button-secondary"
                    onClick={(event) => {
                      event.stopPropagation();
                      inputRef.current?.click();
                    }}
                  >
                    Replace image
                  </button>

                  <button
                    type="button"
                    className="ms-button ms-button-danger"
                    onClick={(event) => {
                      event.stopPropagation();
                      clearScanner();
                    }}
                  >
                    Remove
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="ms-dropzone-icon">
                  ⌕
                </div>

                <h3>
                  Upload prescription
                </h3>

                <p>
                  Click here to choose an image from
                  your computer.
                </p>

                <span className="ms-feature-link">
                  JPG, PNG or WEBP
                </span>
              </>
            )}
          </div>
        </div>

        <div className="ms-panel">
          <div className="ms-panel-title">
            <h3>Before you scan</h3>
          </div>

          <div className="ms-field">
            <label htmlFor="scan-context">
              Optional context
            </label>

            <textarea
              id="scan-context"
              value={context}
              onChange={(event) =>
                setContext(event.target.value)
              }
              placeholder="For example: this prescription is for my father and the handwriting is difficult to read."
            />
          </div>

          <div className="ms-info">
            A clearer image gives the analysis engine a
            better chance of reading the prescription.
            Unclear details will be marked as uncertain
            rather than invented.
          </div>

          {error && (
            <div className="ms-error">
              {error}
            </div>
          )}

          <div className="ms-scanner-actions">
            <button
              type="button"
              className="ms-button ms-button-primary"
              onClick={scanPrescription}
              disabled={loading || !file}
            >
              {loading
                ? "Analyzing..."
                : "Analyze prescription →"}
            </button>

            <button
              type="button"
              className="ms-button ms-button-secondary"
              onClick={openMedly}
            >
              Ask Medly
            </button>
          </div>
        </div>
      </div>

      {currentReport && (
        <section className="ms-report">
          <div className="ms-panel-title">
            <h3>Safety review</h3>

            <span>
              {statusLabel(statusFor(currentReport))}
            </span>
          </div>

          {currentReport.summary && (
            <div className="ms-report-summary">
              {currentReport.summary}
            </div>
          )}

          {medications.length > 0 && (
            <div className="ms-medication-list">
              {medications.map((medicine, index) => (
                <div
                  className="ms-medication-card"
                  key={
                    medicine.name ||
                    medicine.medicine ||
                    index
                  }
                >
                  <div className="ms-medication-name">
                    {medicine.name ||
                      medicine.medicine ||
                      "Medicine"}
                  </div>

                  <div className="ms-medication-meta">
                    {medicine.strength ||
                      medicine.form ||
                      medicine.instructions ||
                      "Details should be verified from the prescription."}
                  </div>
                </div>
              ))}
            </div>
          )}

          {flags.length > 0 && (
            <div className="ms-flag-list">
              {flags.map((flag, index) => {
                const severity =
                  String(
                    flag?.severity || "verify"
                  ).toLowerCase();

                const type =
                  severity.includes("professional")
                    ? "review"
                    : "verify";

                return (
                  <div
                    className={`ms-flag ms-flag-${type}`}
                    key={index}
                  >
                    <strong>
                      {flag?.title ||
                        flag?.message ||
                        "Verification point"}
                    </strong>

                    {flag?.detail && (
                      <>
                        {" — "}
                        {flag.detail}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {Array.isArray(
            currentReport.questions_for_professional
          ) &&
            currentReport.questions_for_professional
              .length > 0 && (
              <div className="ms-report-card">
                <h3>
                  Questions for your professional
                </h3>

                <ul>
                  {currentReport.questions_for_professional.map(
                    (question, index) => (
                      <li key={index}>
                        {question}
                      </li>
                    )
                  )}
                </ul>
              </div>
            )}

          {currentReport.warning && (
            <div className="ms-report-warning">
              {currentReport.warning}
            </div>
          )}
        </section>
      )}
    </>
  );

  const renderHistory = () => (
    <>
      <div className="ms-page-header">
        <div className="ms-page-eyebrow">
          Personal records
        </div>

        <h1 className="ms-page-title">
          My health records
        </h1>

        <p className="ms-page-description">
          Your prescription reviews are stored locally
          in this browser.
        </p>
      </div>

      <div className="ms-history-layout">
        <div className="ms-panel">
          <div className="ms-panel-title">
            <h3>Saved reviews</h3>

            {history.length > 0 && (
              <button
                type="button"
                className="ms-button ms-button-danger"
                onClick={clearHistory}
              >
                Clear
              </button>
            )}
          </div>

          {history.length ? (
            <div className="ms-record-list">
              {history.map((record, index) => {
                const status = statusFor(record);

                return (
                  <button
                    type="button"
                    className={`ms-record ${
                      currentReport === record
                        ? "active"
                        : ""
                    }`}
                    key={
                      record.created_at ||
                      record.id ||
                      index
                    }
                    onClick={() => openRecord(record)}
                  >
                    <div className="ms-record-date">
                      {new Date(
                        record.created_at ||
                          Date.now()
                      ).toLocaleString()}
                    </div>

                    <div className="ms-record-summary">
                      {record.summary ||
                        "Prescription safety review"}
                    </div>

                    <span
                      className={`ms-status ms-status-${status}`}
                    >
                      {statusLabel(status)}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="ms-empty">
              <div className="ms-empty-icon">
                ▤
              </div>

              <h3>
                Nothing saved yet
              </h3>

              <p>
                Scan your first prescription to create
                a local health record.
              </p>

              <button
                type="button"
                className="ms-button ms-button-primary"
                onClick={() => navigate("scanner")}
              >
                Scan prescription
              </button>
            </div>
          )}
        </div>

        <div>
          {currentReport ? (
            <div className="ms-report">
              <div className="ms-panel-title">
                <h3>Selected review</h3>
              </div>

              <div className="ms-report-summary">
                {currentReport.summary ||
                  "No summary available."}
              </div>

              {Array.isArray(
                currentReport.medications
              ) &&
                currentReport.medications.length > 0 && (
                  <div className="ms-medication-list">
                    {currentReport.medications.map(
                      (medicine, index) => (
                        <div
                          className="ms-medication-card"
                          key={index}
                        >
                          <div className="ms-medication-name">
                            {medicine.name ||
                              medicine.medicine ||
                              "Medicine"}
                          </div>

                          <div className="ms-medication-meta">
                            {medicine.strength ||
                              medicine.form ||
                              medicine.instructions ||
                              "Verify prescription details."}
                          </div>
                        </div>
                      )
                    )}
                  </div>
                )}
            </div>
          ) : (
            <div className="ms-empty">
              <div className="ms-empty-icon">
                ⛨
              </div>

              <h3>
                Select a review
              </h3>

              <p>
                Choose a saved prescription review to
                inspect its details.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );

  const renderDiet = () => (
    <>
      <div className="ms-page-header">
        <div className="ms-page-eyebrow">
          General wellness
        </div>

        <h1 className="ms-page-title">
          Food & wellness
        </h1>

        <p className="ms-page-description">
          Simple, general wellness information around
          food and medicines. For medicine-specific
          restrictions, verify with your doctor or pharmacist.
        </p>
      </div>

      <div className="ms-wellness-grid">
        <article className="ms-wellness-card">
          <div className="ms-wellness-icon">
            ✳
          </div>

          <h3>Balanced meals</h3>

          <p>
            Regular balanced meals can support overall
            wellbeing. Medicine-specific food restrictions
            should be checked professionally.
          </p>
        </article>

        <article className="ms-wellness-card">
          <div className="ms-wellness-icon">
            ◌
          </div>

          <h3>Hydration</h3>

          <p>
            Staying adequately hydrated is generally
            helpful, but some conditions and medicines
            may require individualized advice.
          </p>
        </article>

        <article className="ms-wellness-card">
          <div className="ms-wellness-icon">
            ♡
          </div>

          <h3>Ask when unsure</h3>

          <p>
            If you're unsure whether a food, drink or
            supplement fits with a medicine, ask a
            pharmacist or doctor.
          </p>
        </article>
      </div>

      <section className="ms-section">
        <div className="ms-panel">
          <div className="ms-panel-title">
            <h3>Have a medicine-specific question?</h3>
          </div>

          <p className="ms-page-description">
            Medly can help explain the question and,
            when appropriate, help you identify what should
            be verified professionally.
          </p>

          <button
            type="button"
            className="ms-button ms-button-primary"
            onClick={openMedly}
          >
            Ask Medly →
          </button>
        </div>
      </section>
    </>
  );

  const renderPharmacy = () => (
    <>
      <div className="ms-page-header">
        <div className="ms-page-eyebrow">
          Care finder
        </div>

        <h1 className="ms-page-title">
          Find care
        </h1>

        <p className="ms-page-description">
          Find nearby hospitals and pharmacies using
          your map service. Medi-Shield does not assume
          stock, opening hours or availability.
        </p>
      </div>

      <div className="ms-care-grid">
        <article className="ms-care-card">
          <h3>Nearby hospitals</h3>

          <p>
            Open a map search for hospitals around your
            current location.
          </p>

          <div className="ms-care-actions">
            <button
              type="button"
              className="ms-button ms-button-primary"
              onClick={() =>
                window.open(
                  "https://www.google.com/maps/search/hospitals+near+me",
                  "_blank",
                  "noopener,noreferrer"
                )
              }
            >
              Find hospitals →
            </button>
          </div>
        </article>

        <article className="ms-care-card">
          <h3>Nearby pharmacies</h3>

          <p>
            Search for pharmacies around your current
            location.
          </p>

          <div className="ms-care-actions">
            <button
              type="button"
              className="ms-button ms-button-primary"
              onClick={() =>
                window.open(
                  "https://www.google.com/maps/search/pharmacy+near+me",
                  "_blank",
                  "noopener,noreferrer"
                )
              }
            >
              Find pharmacies →
            </button>
          </div>
        </article>

        <article className="ms-care-card">
          <h3>Need help finding a medicine?</h3>

          <p>
            After scanning a prescription, ask Medly
            about locating the exact medicine, strength
            and form. Never substitute a medicine solely
            because another listing is cheaper.
          </p>

          <div className="ms-care-actions">
            <button
              type="button"
              className="ms-button ms-button-secondary"
              onClick={openMedly}
            >
              Ask Medly →
            </button>
          </div>
        </article>

        <article className="ms-care-card">
          <h3>Urgent situation?</h3>

          <p>
            If someone has severe or rapidly worsening
            symptoms, seek emergency medical care rather
            than waiting for an AI response.
          </p>
        </article>
      </div>
    </>
  );

  const renderPage = () => {
    if (page === "scanner") return renderScanner();
    if (page === "history") return renderHistory();
    if (page === "diet") return renderDiet();
    if (page === "pharmacy") return renderPharmacy();

    return renderDashboard();
  };

  return (
    <div className="ms-app">
      {mobileOpen && (
        <button
          type="button"
          className="ms-mobile-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside
        className={`ms-sidebar ${
          mobileOpen ? "mobile-open" : ""
        }`}
      >
        <div className="ms-brand">
          <img
            src="/medi-shield-logo.svg"
            alt="Medi-Shield logo"
          />

          <div className="ms-brand-copy">
            <div className="ms-brand-name">
              Medi-Shield
            </div>

            <div className="ms-brand-subtitle">
              Medication safety
            </div>
          </div>
        </div>

        <nav className="ms-nav">
          <div className="ms-nav-label">
            Workspace
          </div>

          {NAV.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`ms-nav-button ${
                page === item.id ? "active" : ""
              }`}
              onClick={() => navigate(item.id)}
            >
              <span className="ms-nav-icon">
                {item.icon}
              </span>

              <span className="ms-nav-text">
                {item.label}
              </span>
            </button>
          ))}
        </nav>

        <div className="ms-sidebar-bottom">
          <div className="ms-safety-mini">
            <div className="ms-safety-mini-title">
              <span>⛨</span>
              Safety first
            </div>

            <p>
              Medi-Shield explains and highlights
              verification points. It does not diagnose
              or change treatment.
            </p>
          </div>
        </div>
      </aside>

      <main className="ms-main">
        <header className="ms-topbar">
          <div className="ms-topbar-left">
            <div className="ms-topbar-kicker">
              Medi-Shield
            </div>

            <div className="ms-topbar-title">
              {NAV.find(
                (item) => item.id === page
              )?.label || "Overview"}
            </div>
          </div>

          <button
            type="button"
            className="ms-mobile-menu"
            onClick={() =>
              setMobileOpen((value) => !value)
            }
            aria-label="Open navigation"
          >
            ☰
          </button>
        </header>

        <div className="ms-page">
          {renderPage()}
        </div>

        <footer className="ms-footer">
          <strong>Medi-Shield</strong> is an AI-assisted
          medication-safety companion. It does not replace
          a doctor, pharmacist or other qualified healthcare
          professional.
        </footer>
      </main>

      {!medlyOpen && (
        <button
          type="button"
          className="ms-medly-launcher"
          onClick={openMedly}
        >
          <span className="ms-launcher-orb">
            ✦
          </span>

          <span>Talk to Medly</span>

          <i>↗</i>
        </button>
      )}

      {medlyOpen && (
        <div className="ms-medly-layer">
          <button
            type="button"
            className="ms-medly-dismiss"
            onClick={() => setMedlyOpen(false)}
            aria-label="Close Medly"
          >
            ×
          </button>

          <Medly
            onNavigate={(target) => {
              setMedlyOpen(false);
              navigate(target);
            }}
          />
        </div>
      )}
    </div>
  );
}