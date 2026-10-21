"use strict";

(() => {
  const param = new URLSearchParams(window.location.search).get("scoutTheme");
  const theme = param === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", theme);
})();

(() => {
  const $ = id => document.getElementById(id);
  const state = {
    status: null, statusError: null, checking: false, scenarios: [], scenariosError: null,
    catalog: null, catalogError: null, analyzing: false, searching: false, checkingBoundary: false,
    answer: null, dialogGeneration: 0, activeStoryId: null, observations: {}, routeFocus: null,
    assistantOpen: false, assistantReturnFocus: null, turns: [], turnSequence: 0,
    policyRegister: null, policyError: null, policyLoading: false, policyAttempted: false,
    policyAsOf: null, answerContexts: new Map()
  };
  const capabilityNames = {
    guided: "Guided analytics", naturalLanguage: "Natural-language model",
    knowledge: "Knowledge retrieval", evidence: "Evidence retrieval"
  };
  const serviceNames = { broker: "Analytics broker", knowledge: "Rule knowledge", model: "Regional model" };
  const numberFormat = new Intl.NumberFormat("en-CA", { maximumFractionDigits: 2 });
  const moneyFormat = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", currencyDisplay: "code", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const assistantOverlay = window.matchMedia("(max-width: 1100px)");
  const supportedQuestions = [
    { label: "Compare losses by channel", question: "How did CAD fraud losses by channel change from August to September 2026?" },
    { label: "Compare losses by province", question: "Compare CAD fraud losses by province for September 2026 versus August 2026." },
    { label: "Explore rule false-positive share", question: "Compare adjudicated-alert false-positive share by channel for September 2026 versus August 2026." }
  ];

  function text(value, fallback = "Not returned") {
    return ["string", "number", "boolean"].includes(typeof value) ? String(value) : fallback;
  }
  function element(tag, content, className) {
    const node = document.createElement(tag);
    if (content !== undefined) node.textContent = text(content, "");
    if (className) node.className = className;
    return node;
  }
  function list(values, ordered = false) {
    const node = element(ordered ? "ol" : "ul");
    for (const value of values) node.append(element("li", value));
    return node;
  }
  function button(label, action, className = "button secondary") {
    const node = element("button", label, className);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  }
  function hasCapability(name) {
    return state.status?.capabilities?.[name] === true;
  }
  function capabilityReason(name) {
    if (state.checking) return `${capabilityNames[name]}: checking readiness`;
    if (state.statusError) return `${capabilityNames[name]}: connection unavailable`;
    const value = state.status?.capabilities?.[name];
    if (value === false) return `${capabilityNames[name]}: unavailable`;
    if (value !== true) return `${capabilityNames[name]}: readiness not reported`;
    return null;
  }
  function serviceState(value) {
    if (["ready", "available", "healthy", "connected", "ok"].includes(value)) return { label: "Ready", kind: "ready" };
    if (["unavailable", "error", "failed", "blocked", "disabled", "not-configured", "not_configured", "degraded"].includes(value)) return { label: text(value).replaceAll("_", " ").replaceAll("-", " "), kind: "failed" };
    return { label: value ? text(value) : "Pending", kind: "pending" };
  }
  function formatValue(value, format, currency) {
    if (value === undefined) return "Not returned";
    if (value === null) return ["percent", "percentagePoints"].includes(format) ? "Undefined" : "Not applicable";
    if (format === "text" || !format) return text(value);
    if (typeof value !== "number" || !Number.isFinite(value)) return "Invalid numeric value";
    if (format === "currency") return currency && currency !== "CAD" ? `${numberFormat.format(value)} ${text(currency)}` : moneyFormat.format(value);
    if (format === "percent") return `${numberFormat.format(value)}%`;
    if (format === "percentagePoints") return `${numberFormat.format(value)} pp`;
    if (format === "number") return numberFormat.format(value);
    return text(value);
  }
  function formatTime(value) {
    if (!value) return "Not returned";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return text(value);
    return `${date.toISOString().replace("T", " ").slice(0, 19)} UTC`;
  }
  function sourceContextMessage(source) {
    if (source?.type === "local-synthetic-fixtures") {
      return "Local preview uses synthetic fixtures. It is not connected to Azure SQL, Fabric or Foundry. These results do not validate production integrations or scale.";
    }
    if (source?.type === "azure-sql-database") {
      return "The API identifies an Azure SQL Database source for synthetic data. Service readiness is reported separately. SQL MI / Oracle integration and 1 TB scale are not validated here.";
    }
    return "The source connection is not verified here. No Azure SQL, Fabric, Foundry or production-scale validation is implied. Inspect the reported source metadata and service readiness.";
  }

  class ApiError extends Error {
    constructor(message, { code = "REQUEST_FAILED", status = 0, traceId } = {}) {
      super(message);
      this.name = "ApiError";
      this.code = code;
      this.status = status;
      this.traceId = traceId;
    }
  }
  function retryAfterHint(value, now = Date.now()) {
    if (typeof value !== "string" || !value.trim()) return "";
    const header = value.trim();
    let seconds;
    if (/^\d+$/.test(header)) seconds = Number(header);
    else if (/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header)) {
      const timestamp = Date.parse(header);
      if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== header) return "";
      seconds = Math.ceil((timestamp - now) / 1000);
    }
    if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 31536000) return "";
    if (seconds <= 120) return ` Retry after ${seconds} second${seconds === 1 ? "" : "s"}.`;
    const minutes = Math.ceil(seconds / 60);
    const hours = Math.floor(minutes / 60), remaining = minutes % 60;
    const parts = [];
    if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
    if (remaining) parts.push(`${remaining} minute${remaining === 1 ? "" : "s"}`);
    return ` Retry after ${parts.join(" ")}.`;
  }
  async function request(url, options = {}) {
    const target = new URL(url, window.location.origin);
    if (target.origin !== window.location.origin) throw new ApiError("Only same-origin API requests are allowed.", { code: "UNSAFE_ENDPOINT" });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    let response;
    try {
      response = await fetch(target.href, {
        ...options, headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
        credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal
      });
      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); } catch { data = null; }
      if (!response.ok) {
        const retryHint = retryAfterHint(response.headers.get("Retry-After"));
        const message = response.status === 401 || response.status === 403
          ? "This public synthetic demo request was denied by the service. The demo operator may need to check service configuration."
          : response.status === 429
            ? data?.error?.code === "DEMO_DAILY_LIMIT"
              ? `The shared synthetic demo has reached its daily request limit. Try again after midnight UTC.${retryHint}`
              : data?.error?.code === "DEMO_BUSY"
                ? `Two analysis or knowledge requests are already running. Wait for one to finish before retrying.${retryHint}`
                : `The request rate limit has been reached.${retryHint || " Wait before retrying."}`
            : response.status === 503
              ? `The demo is temporarily busy or a required service is unavailable.${retryHint || " Please try again later."}`
              : text(data?.error?.message, `The service returned HTTP ${response.status}. No result is available.`);
        throw new ApiError(message, { status: response.status, code: text(data?.error?.code, `HTTP_${response.status}`), traceId: data?.error?.traceId });
      }
      if (!data || typeof data !== "object") throw new ApiError("The service did not return a JSON response. The demo operator may need to check the API route.", { status: response.status, code: "INVALID_RESPONSE" });
      if (data.error) throw new ApiError(text(data.error.message, "The service returned an error."), { code: text(data.error.code), traceId: data.error.traceId, status: response.status });
      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error.name === "AbortError") throw new ApiError("The service did not respond within 90 seconds. No result has been substituted.", { code: "REQUEST_TIMEOUT" });
      throw new ApiError(state.status?.localPreview === true || state.status?.source?.type === "local-synthetic-fixtures"
        ? "Unable to reach the local preview. Check that its server is still running. No cached or sample answer has been substituted."
        : "Unable to reach the analyst workbench API. Check the service connection or try again later. No cached or sample answer has been substituted.", { code: "CONNECTION_FAILED" });
    } finally {
      clearTimeout(timeout);
    }
  }
  function errorPanel(error, heading = "This request did not complete", retry) {
    const panel = element("div", undefined, "notice error");
    panel.setAttribute("role", "alert");
    panel.append(element("h3", heading), element("p", error.message));
    panel.append(element("p", `${error.status ? `HTTP ${error.status} · ` : ""}${text(error.code, "REQUEST_FAILED")}`, "small mono"));
    if (error.status === 429) panel.append(element("p", "No automatic retry is sent. Each retry is a new request subject to service limits.", "small muted"));
    if (error.traceId) panel.append(element("p", `Trace: ${text(error.traceId)}`, "small mono"));
    if (retry) panel.append(button("Try again", retry));
    return panel;
  }
  function notice(message) {
    return element("div", message, "notice");
  }
  function loading(message) {
    return element("div", message, "loading");
  }

  function renderReadiness() {
    const services = $("service-list");
    services.replaceChildren();
    for (const [key, name] of Object.entries(serviceNames)) {
      const service = state.status?.services?.[key];
      const readiness = serviceState(service?.status);
      const row = element("div", undefined, "service-row");
      const label = element("span", undefined, "service-label");
      const dot = element("span", undefined, `status-dot ${state.statusError ? "failed" : readiness.kind}`);
      dot.setAttribute("aria-hidden", "true");
      label.append(dot, element("span", name));
      const badge = element("span", state.statusError ? "Unreachable" : readiness.label, "pill");
      if (service?.detail) badge.title = text(service.detail);
      row.append(label, badge);
      services.append(row);
    }
    $("source-label").textContent = text(state.status?.source?.label, state.statusError ? "Source could not be verified" : "Waiting for the API");
    $("snapshot-date").textContent = state.status?.source?.asOf ? formatTime(state.status.source.asOf) : state.statusError ? "Source unavailable" : "Timestamp not reported";
    $("identity").textContent = state.status?.source?.type === "local-synthetic-fixtures" ? "Local preview · No sign-in" : "Public demo · No sign-in";
    const ready = Object.keys(capabilityNames).filter(hasCapability).length;
    $("connection-label").textContent = state.checking ? "Checking availability" : state.statusError ? "Currently unavailable" : state.status ? state.status.synthetic !== true ? "Data scope not verified" : ready === 4 ? "Services available" : `${ready} of 4 features available` : "Availability pending";
    $("connection-open").querySelector(".status-dot").className = `status-dot ${state.statusError ? "failed" : ready === 4 && state.status?.synthetic === true ? "ready" : "pending"}`;
    $("refresh-status").disabled = state.checking;
    const alert = $("connection-alert");
    alert.hidden = !state.statusError && state.status?.synthetic === true;
    if (state.statusError) {
      alert.replaceChildren(errorPanel(state.statusError, "Workspace connection unavailable"));
      alert.className = "";
    } else {
      alert.className = "notice";
      alert.textContent = state.status
        ? "Synthetic-data readiness was not confirmed by the API. Analysis controls remain unavailable."
        : "Waiting for a verified service response. No analysis has been run.";
    }
    updateControls();
    renderStories();
  }
  function analysisAllowed(name) {
    return state.status?.synthetic === true && hasCapability(name);
  }
  function updateControls() {
    const modelEnabled = analysisAllowed("naturalLanguage");
    $("question-input").disabled = !modelEnabled || state.analyzing;
    $("ask-submit").disabled = !modelEnabled || state.analyzing;
    $("ask-submit").textContent = state.analyzing ? "Analysis in progress…" : "Ask a question →";
    $("ask-form").setAttribute("aria-busy", String(state.analyzing));
    for (const node of document.querySelectorAll("[data-answer-button]")) node.disabled = state.analyzing;
    $("model-badge").textContent = hasCapability("naturalLanguage") && state.status?.synthetic === true ? "Model available" : "Unavailable";
    if (state.checking || !state.statusError && typeof state.status?.capabilities?.naturalLanguage !== "boolean") $("model-badge").textContent = "Pending";
    $("question-availability").textContent = modelEnabled
      ? `Model-planned analytics${state.status?.model?.deployment ? ` · ${text(state.status.model.deployment)}` : ""}. Your question is sent to the server.`
      : `${capabilityReason("naturalLanguage") || "Synthetic-data status not confirmed"}. Guided analytics remain a separate capability.`;
    for (const node of document.querySelectorAll("[data-scenario-id]")) node.disabled = !analysisAllowed("guided") || state.analyzing;
    const knowledgeEnabled = analysisAllowed("knowledge");
    for (const id of ["knowledge-query", "knowledge-date", "knowledge-submit", "knowledge-subject", "knowledge-channel", "knowledge-province"]) $(id).disabled = !knowledgeEnabled || state.searching;
    $("knowledge-availability").textContent = knowledgeEnabled
      ? "Access and effective-date filtering are handled by the knowledge service."
      : `${capabilityReason("knowledge") || "Synthetic-data status not confirmed"}. No local documents will be substituted.`;
    $("boundary-submit").disabled = !analysisAllowed("guided") || state.checkingBoundary;
    $("boundary-case").disabled = state.checkingBoundary;
    for (const node of document.querySelectorAll("[data-evidence-button]")) node.disabled = !hasCapability("evidence");
    for (const node of document.querySelectorAll("[data-example-capability]")) {
      const capability = node.dataset.exampleCapability;
      node.disabled = !analysisAllowed(capability) || (capability === "knowledge" ? state.searching : state.analyzing);
    }
    $("walkthrough-start").disabled = !state.catalog?.stories.length;
    $("walkthrough-start-hero").disabled = !state.catalog?.stories.length;
    $("policy-refresh").disabled = state.status?.synthetic !== true || state.policyLoading;
    $("policy-refresh").textContent = state.policyLoading ? "Loading…" : state.policyRegister ? "Refresh policy register" : "Load policy register";
    if (!state.policyAttempted) $("policy-availability").textContent = state.status?.synthetic === true
      ? "Available to request · the service determines which policy metadata you may see."
      : "Waiting for verified synthetic-data access. No local policy snapshot will be substituted.";
    renderWalkthrough();
  }
  async function refreshStatus() {
    if (state.checking) return;
    state.checking = true;
    state.status = null;
    state.statusError = null;
    renderReadiness();
    try {
      const result = await request("/api/status");
      if (Array.isArray(result)) throw new ApiError("The status response has an unexpected shape.", { code: "INVALID_RESPONSE" });
      state.status = result;
    } catch (error) {
      state.statusError = error;
    } finally {
      state.checking = false;
      renderReadiness();
      if (location.hash === "#knowledge" && !state.policyAttempted && state.status?.synthetic === true) loadPolicies();
    }
  }
  function openDialog(title, kicker) {
    state.dialogGeneration += 1;
    $("dialog-title").textContent = title;
    $("dialog-kicker").textContent = kicker;
    $("dialog-body").replaceChildren();
    if (!$("detail-dialog").open) $("detail-dialog").showModal();
    return state.dialogGeneration;
  }
  function metadata(entries) {
    const dl = element("dl", undefined, "metadata");
    for (const [key, value] of entries) dl.append(element("dt", key), element("dd", text(value)));
    return dl;
  }
  function connectionDetails() {
    const generation = openDialog("Connection & readiness", "Reported by the API");
    const body = $("dialog-body");
    if (state.statusError) body.append(errorPanel(state.statusError, "Status could not be retrieved"));
    body.append(element("p", "Capabilities are enabled only when the server explicitly reports them available. Unknown fields are pending, not successful.", "small muted"));
    body.append(metadata(Object.entries(capabilityNames).map(([key, label]) => [label, hasCapability(key) ? "Available" : capabilityReason(key)])));
    for (const [key, label] of Object.entries(serviceNames)) {
      const service = state.status?.services?.[key];
      body.append(element("h3", label), element("p", `${serviceState(service?.status).label} · ${text(service?.detail, "No service detail returned")}`, "small muted"));
    }
    body.append(metadata([
      ["Source type", state.status?.source?.type], ["Source", state.status?.source?.label],
      ["Configured model deployment", state.status?.model?.deployment], ["Configured model version", state.status?.model?.version],
      ["Synthetic data", state.status?.synthetic === true ? "Confirmed by API" : "Not confirmed"],
      ["Public demo mode", state.status?.publicDemo === true ? "Confirmed by API · no sign-in or VPN required" : "Not reported by API"],
      ["Product identity", "Rogers-inspired concept. Not an official Rogers portal. No authenticated analyst identity."]
    ]));
    if (state.status?.limits && typeof state.status.limits === "object") {
      const limits = element("details");
      limits.append(element("summary", "Shared usage limits reported by the API"), element("pre", JSON.stringify(state.status.limits, null, 2), "evidence-json"));
      body.append(limits);
    }
    body.append(element("h3", "Limitations"));
    body.append(Array.isArray(state.status?.limitations) && state.status.limitations.length
      ? list(state.status.limitations)
      : element("p", "No limitations were returned by the API. This is not a claim of production or scale validation.", "small muted"));
    body.append(notice(sourceContextMessage(state.status?.source)));
    body.append(button("Refresh readiness", async () => {
      await refreshStatus();
      if ($("detail-dialog").open && generation === state.dialogGeneration) connectionDetails();
    }));
  }
  function periodLabel(scenario) {
    const current = scenario.request?.current;
    const previous = scenario.request?.previous;
    if (!current || !previous) return "Periods defined by the server";
    return `${text(current.start)} → ${text(current.end)} vs ${text(previous.start)} → ${text(previous.end)} · end dates exclusive`;
  }
  function friendlyPeriod(scenario) {
    const label = period => {
      if (!period?.start || !period?.end) return null;
      const start = new Date(`${period.start}T00:00:00Z`);
      const end = new Date(`${period.end}T00:00:00Z`);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
      const format = date => date.toLocaleDateString("en-CA", { month: "short", year: "numeric", timeZone: "UTC" });
      if (start.getUTCDate() === 1 && end.getUTCDate() === 1 && end.getTime() === Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)) return format(start);
      return `${period.start} – ${period.end} (exclusive)`;
    };
    const current = label(scenario.request?.current), previous = label(scenario.request?.previous);
    return current && previous ? `${current} compared with ${previous}` : periodLabel(scenario);
  }
  function renderScenarios() {
    const target = $("scenario-list");
    target.replaceChildren();
    if (state.scenariosError) {
      $("reporting-window").textContent = "Periods unavailable";
      $("reporting-dates").textContent = "The scenario service did not return a verified reporting window.";
      target.append(errorPanel(state.scenariosError, "Guided analyses could not be loaded", loadScenarios));
      return;
    }
    if (!state.scenarios.length) {
      $("reporting-window").textContent = "No available comparisons";
      $("reporting-dates").textContent = "No reporting periods returned.";
      target.append(notice("The API returned no guided scenarios. No sample analyses have been added locally."));
      return;
    }
    const sharedPeriods = state.scenarios.every(scenario =>
      JSON.stringify(scenario.request?.current) === JSON.stringify(state.scenarios[0].request?.current) &&
      JSON.stringify(scenario.request?.previous) === JSON.stringify(state.scenarios[0].request?.previous));
    $("reporting-window").textContent = sharedPeriods ? friendlyPeriod(state.scenarios[0]) : "Select a comparison below";
    $("reporting-dates").textContent = sharedPeriods ? "Current vs previous · complete reporting periods" : "Reporting dates differ by investigation.";
    state.scenarios.forEach((scenario, index) => {
      const card = element("article", undefined, "scenario-card");
      const top = element("div", undefined, "card-top");
      const icon = element("span", scenario.request?.kind === "rule_quality" ? "◎" : "↗", "feature-icon");
      icon.setAttribute("aria-hidden", "true");
      top.append(icon, element("span", scenario.request?.kind === "rule_quality" ? "RULE OUTCOMES" : "LOSS MOVEMENT", "card-number"));
      const period = element("p", friendlyPeriod(scenario), "period-label");
      const range = element("details", undefined, "period-details");
      range.append(element("summary", "Exact reporting dates"), element("p", periodLabel(scenario)));
      card.append(top, element("h3", scenario.title), element("p", scenario.question), period, range);
      const run = button("Run analysis →", () => runAnalysis("/api/analyze", scenario.request, text(scenario.question, text(scenario.title)), "guided"));
      run.id = `scenario-${index}`;
      run.dataset.scenarioId = text(scenario.id);
      run.setAttribute("aria-label", `Run analysis: ${text(scenario.title)}`);
      card.append(run);
      target.append(card);
    });
    updateControls();
  }
  async function loadScenarios() {
    $("scenario-list").replaceChildren(loading("Loading server-defined scenarios…"));
    state.scenariosError = null;
    try {
      const result = await request("/api/scenarios");
      if (!Array.isArray(result) || result.some(item => !item || typeof item.id !== "string" || typeof item.title !== "string" || !item.request || typeof item.request !== "object")) {
        throw new ApiError("The scenarios response has an unexpected shape.", { code: "INVALID_RESPONSE" });
      }
      state.scenarios = result;
    } catch (error) {
      state.scenarios = [];
      state.scenariosError = error;
    }
    renderScenarios();
    renderStories();
  }
  function validateAnswer(answer, mode) {
    if (answer.synthetic !== true || typeof answer.answerId !== "string" ||
        !Array.isArray(answer.metrics) || !Array.isArray(answer.table?.columns) || !Array.isArray(answer.table?.rows) ||
        !answer.narrative || typeof answer.narrative !== "object" || answer.provenance?.mode !== mode ||
        answer.metrics.some(metric => !metric || typeof metric.label !== "string") ||
        answer.table.columns.some(column => !column || typeof column.key !== "string" || typeof column.label !== "string") ||
        answer.table.rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
      throw new ApiError("The service response could not be verified as a synthetic analysis in the requested execution mode. No result has been displayed.", { code: "INVALID_ANALYSIS_RESPONSE", traceId: answer.provenance?.traceId });
    }
    return answer;
  }
  function updateQuestionCount() {
    $("question-count").textContent = `${numberFormat.format($("question-input").value.length)} / 1,000 characters`;
    $("question-validation").textContent = "";
    $("question-input").removeAttribute("aria-invalid");
  }
  function setAssistantOpen(open, restoreFocus = true) {
    const panel = $("assistant-panel");
    if (open === state.assistantOpen) return;
    state.assistantOpen = open;
    $("assistant-toggle").setAttribute("aria-expanded", String(open));
    for (const id of ["assistant-open-hero", "assistant-open-header"]) $(id).setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("assistant-open", open);
    $("composer-away").hidden = !open;
    if (open) {
      state.assistantReturnFocus = document.activeElement;
      $("assistant-composer-home").append($("ask-composer"));
      if (assistantOverlay.matches) panel.showModal();
      else panel.show();
      ($("question-input").disabled ? $("assistant-close") : $("question-input")).focus();
    } else {
      panel.close();
      $("question-composer-home").append($("ask-composer"));
      if (restoreFocus) {
        const previous = state.assistantReturnFocus;
        (previous?.isConnected && !previous.closest("[hidden]") && !previous.disabled ? previous : $("assistant-toggle")).focus();
      }
    }
  }
  function syncAssistantPresentation() {
    const panel = $("assistant-panel");
    // Reopening an underlying dialog would put it above the active evidence modal.
    if (!state.assistantOpen || $("detail-dialog").open || panel.matches(":modal") === assistantOverlay.matches) return;
    const focus = document.activeElement;
    panel.close();
    if (assistantOverlay.matches) panel.showModal();
    else panel.show();
    if (panel.contains(focus)) focus.focus();
  }
  function renderAssistantSuggestions() {
    for (const example of supportedQuestions) {
      const action = button(`${example.label} ↗`, () => loadExample(example, "naturalLanguage"), "button quiet");
      action.dataset.exampleCapability = "naturalLanguage";
      action.title = example.question;
      $("assistant-suggestions").append(action);
    }
  }
  function showTurnAnswer(turn) {
    if (state.analyzing || !turn.answer) return;
    state.answer = turn.answer;
    renderAnswer(turn.answer, turn.question);
    $("analysis-state").textContent = "Selected response from this tab";
    $("analysis-announcement").textContent = `Showing response to: ${turn.question}`;
    if (assistantOverlay.matches) setAssistantOpen(false, false);
    navigate("analysis", "analysis");
    updateControls();
  }
  function renderAssistantTurn(turn) {
    const card = turn.node;
    card.replaceChildren(element("p", `Question ${turn.id} · standalone`, "overline"), element("h3", turn.question));
    if (turn.error) {
      const failure = errorPanel(turn.error, "No answer returned", () => runAnalysis("/api/ask", { question: turn.question }, turn.question, "natural-language"));
      failure.querySelector("button").dataset.answerButton = "";
      card.append(failure);
    } else if (turn.answer) {
      const answer = turn.answer;
      card.append(element("span", "API response · model planned", "pill accent"), element("p", answer.narrative.headline, "assistant-answer-headline"), element("p", answer.narrative.text, "small"));
      if (answer.metrics.length) card.append(renderMetrics(answer.metrics));
      card.append(renderPolicyResolution(answer.knowledge?.policyResolution));
      const coverage = renderSourceCoverage(answer.knowledge?.sourceCoverage);
      if (coverage) card.append(coverage);
      card.append(element("p", "Read the full analysis for the returned breakdown, caveats and investigation steps.", "small muted"));
      const sources = answer.knowledge?.sources;
      if (answer.knowledge?.status === "available" && Array.isArray(sources) && sources.length) {
        const citations = element("details", undefined, "assistant-citations");
        citations.append(element("summary", `${sources.length} returned citation${sources.length === 1 ? "" : "s"}`), renderSources(sources));
        card.append(citations);
      } else card.append(notice("No citations available for this response. It is not definition-verified."));
      const actions = element("div", undefined, "row wrap assistant-answer-actions");
      const view = button("View full analysis →", () => showTurnAnswer(turn), "button secondary compact");
      view.dataset.answerButton = "";
      actions.append(view);
      if (safeEvidenceUrl(answer.evidenceUrl)) {
        const evidence = button("Inspect evidence", () => showEvidence(answer), "button quiet compact");
        evidence.dataset.evidenceButton = "";
        actions.append(evidence);
      }
      card.append(actions);
    } else {
      card.append(loading("Asking the model and analytics API…"));
    }
    card.setAttribute("aria-busy", String(!turn.answer && !turn.error));
  }
  function addAssistantTurn(question) {
    const turn = { id: ++state.turnSequence, question, answer: null, error: null, node: element("article", undefined, "assistant-turn") };
    turn.node.setAttribute("aria-label", `Question ${turn.id}: ${question}`);
    state.turns.push(turn);
    if (state.turns.length > 8) state.turns.shift().node.remove();
    $("assistant-empty").hidden = true;
    renderAssistantTurn(turn);
    $("assistant-history").append(turn.node);
    $("assistant-announcement").textContent = `Question ${turn.id} sent. Waiting for the API response.`;
    if (state.assistantOpen) $("assistant-scroll").scrollTop = $("assistant-scroll").scrollHeight;
    return turn;
  }
  function submitQuestion(event) {
    event.preventDefault();
    const input = $("question-input");
    const question = input.value.trim();
    if (state.analyzing || !analysisAllowed("naturalLanguage")) return;
    if (question.length < 8 || input.value.length > 1000) {
      $("question-validation").textContent = "Use 8–1,000 characters for a standalone question.";
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }
    runAnalysis("/api/ask", { question }, question, "natural-language");
  }
  async function runAnalysis(endpoint, payload, question, mode) {
    const requiredCapability = mode === "guided" ? "guided" : "naturalLanguage";
    if (state.analyzing || !analysisAllowed(requiredCapability)) return;
    state.analyzing = true;
    state.answer = null;
    const turn = mode === "natural-language" ? addAssistantTurn(question) : null;
    $("analysis").setAttribute("aria-busy", "true");
    $("analysis-state").textContent = mode === "guided" ? "Running guided analysis" : "Requesting model-planned analysis";
    $("analysis-announcement").textContent = "Analysis started.";
    $("analysis-content").replaceChildren(element("p", question, "question-echo"), loading("Waiting for the analytics API. Results will appear only after a successful response."));
    updateControls();
    if (!state.assistantOpen) $("analysis").scrollIntoView({ behavior: "auto", block: "start" });
    try {
      const result = validateAnswer(await request(endpoint, { method: "POST", body: JSON.stringify(payload) }), mode);
      state.answer = result;
      if (mode === "guided") {
        state.answerContexts.set(result.answerId, payload);
        if (state.answerContexts.size > 16) state.answerContexts.delete(state.answerContexts.keys().next().value);
      }
      renderAnswer(result, question);
      if (turn) {
        turn.answer = result;
        renderAssistantTurn(turn);
        $("assistant-announcement").textContent = `Question ${turn.id}: response received. ${result.metrics.length} metrics and ${result.table.rows.length} breakdown rows.`;
      }
      $("analysis-state").textContent = "Response received";
      $("analysis-announcement").textContent = `Analysis returned: ${text(result.narrative.headline)}. ${result.table.rows.length} rows.`;
      recordObservation(mode === "natural-language" ? "FI-06" : payload.kind === "rule_quality" ? "FI-02" : "FI-01",
        `API returned answer ${text(result.answerId)} in ${text(result.provenance.mode)} mode. Compare the actual metrics, caveats and evidence; no acceptance check is automatic.`);
    } catch (error) {
      if (turn) {
        turn.error = error;
        renderAssistantTurn(turn);
        $("assistant-announcement").textContent = `Question ${turn.id} failed. ${error.message}`;
      }
      $("analysis-content").replaceChildren(element("p", question, "question-echo"), errorPanel(error, "Analysis unavailable", () => runAnalysis(endpoint, payload, question, mode)));
      $("analysis-state").textContent = "Request failed · no result";
      $("analysis-announcement").textContent = "Analysis failed. Review the error details.";
      recordObservation(mode === "natural-language" ? "FI-06" : payload.kind === "rule_quality" ? "FI-02" : "FI-01",
        `${error.status ? `HTTP ${error.status} · ` : ""}${text(error.code)}. No answer displayed. Inspect the actual error below; a failure is not automatically a demonstrated refusal.`);
    } finally {
      state.analyzing = false;
      $("analysis").removeAttribute("aria-busy");
      updateControls();
    }
  }
  function renderSources(sources) {
    const grid = element("div", undefined, "source-grid");
    for (const source of sources) {
      if (!source || typeof source !== "object") continue;
      const card = element("article", undefined, "panel citation");
      card.append(element("span", text(source.citationId, "Citation ID not returned"), "pill accent"), element("h3", source.title));
      card.append(element("p", `Version ${text(source.version)} · Effective from ${text(source.effectiveFrom)}${source.effectiveTo ? ` until ${text(source.effectiveTo)} (exclusive)` : source.effectiveTo === null ? " · Open-ended" : " · End date not returned"}`, "citation-meta"));
      if (source.policyId) card.append(element("p", `Policy ${text(source.policyId)}`, "citation-meta mono"));
      if (source.scope) card.append(element("p", scopeLabel(source.scope), "citation-meta"));
      card.append(element("p", `Document ${text(source.documentId)} · Chunk ${text(source.chunkId)}`, "citation-meta mono"));
      if (Array.isArray(source.appliesTo) && source.appliesTo.length) {
        const applicability = element("details", undefined, "source-applicability");
        applicability.append(element("summary", `Applicability · ${source.appliesTo.length} returned context${source.appliesTo.length === 1 ? "" : "s"}`));
        const contexts = element("ul");
        for (const context of source.appliesTo) {
          if (!context || typeof context !== "object") continue;
          const item = element("li");
          item.append(element("p", context.period
            ? `${text(context.period)} · ${text(context.start)} → ${text(context.end)} (exclusive)`
            : `Applicable as of ${text(context.asOf)}`, "small"),
          element("p", scopeLabel(context.scope), "citation-meta"));
          contexts.append(item);
        }
        applicability.append(contexts);
        card.append(applicability);
      }
      const details = element("details");
      details.append(element("summary", "Read source excerpt"), element("p", source.excerpt, "citation-excerpt"));
      card.append(details);
      grid.append(card);
    }
    return grid;
  }
  function renderMetrics(values) {
    const metrics = element("div", undefined, "metrics-grid");
    for (const metric of values) {
      const card = element("div", undefined, "metric-card");
      card.append(element("p", metric.label, "metric-label"), element("strong", formatValue(metric.value, metric.format, metric.currency), "metric-value"));
      if (metric.detail) card.append(element("p", metric.detail, "metric-detail"));
      metrics.append(card);
    }
    return metrics;
  }
  function renderComparisonChart(table) {
    const columns = table.columns;
    const pair = [["currentLoss", "previousLoss"], ["currentShare", "previousShare"]]
      .find(keys => keys.every(key => columns.some(column => column.key === key)));
    if (!pair || !table.rows.length) return null;
    const rows = table.rows.slice(0, 6);
    if (rows.some(row => pair.some(key => typeof row[key] !== "number" || !Number.isFinite(row[key]) || row[key] < 0))) return null;
    const max = Math.max(...rows.flatMap(row => pair.map(key => row[key])));
    const chart = element("figure", undefined, "panel comparison-chart");
    const label = pair[0] === "currentLoss" ? "Loss comparison by returned group" : "Adjudicated-alert false-positive share";
    chart.append(element("figcaption", label));
    const legend = element("div", undefined, "chart-legend");
    legend.append(element("span", "Current period"), element("span", "Previous period"));
    chart.append(legend);
    for (const row of rows) {
      const item = element("div", undefined, "chart-row");
      item.append(element("strong", `${text(row.group)}${row.ruleId ? ` · ${text(row.ruleId)}` : ""}`));
      const bars = element("div", undefined, "chart-pair");
      pair.forEach((key, index) => {
        const column = columns.find(column => column.key === key);
        const value = formatValue(row[key], column.format, column.currency);
        const bar = element("div", undefined, `chart-bar${index ? " previous" : ""}`);
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 500 12");
        svg.setAttribute("preserveAspectRatio", "none");
        svg.setAttribute("aria-hidden", "true");
        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("width", String(max === 0 ? 0 : row[key] / max * 500));
        rect.setAttribute("height", "12");
        rect.setAttribute("rx", "2");
        svg.append(rect);
        const amount = element("span");
        amount.append(element("span", `${index ? "Previous" : "Current"}: `, "sr-only"), document.createTextNode(value));
        bar.append(svg, amount);
        bars.append(bar);
      });
      item.append(bars);
      chart.append(item);
    }
    chart.append(element("p", `${rows.length} of ${table.rows.length} returned rows, in API order. Shared zero baseline; exact values and all rows are in the table below.`, "small muted"));
    return chart;
  }
  function renderAnswer(answer, question) {
    const target = $("analysis-content");
    target.replaceChildren();
    const header = element("div", undefined, "answer-header");
    const top = element("div", undefined, "row wrap");
    top.append(element("span", "Synthetic aggregate result", "pill accent"), element("span", answer.provenance.mode === "guided" ? "Guided · deterministic" : "Natural language · model planned", "pill"));
    header.append(top, element("div", question, "question-echo"), element("h3", answer.narrative.headline), element("p", answer.narrative.text));
    const context = answer.params || answer.knowledge?.policyResolution?.periods || state.answerContexts.get(answer.answerId);
    header.append(element("p", context?.current && context?.previous
      ? `Requested comparison · ${periodLabel({ request: context })}`
      : "Reporting periods: see the standalone question and stored evidence request.", "answer-periods"));
    target.append(header);
    if (answer.metrics.length) target.append(renderMetrics(answer.metrics));
    target.append(renderPolicyContext(answer.knowledge));
    const chart = renderComparisonChart(answer.table);
    if (chart) target.append(chart);
    const tablePanel = element("div", undefined, "panel table-panel");
    const scroll = element("div", undefined, "table-scroll");
    scroll.tabIndex = 0;
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", "Analysis breakdown, horizontally scrollable when needed");
    const table = element("table");
    table.append(element("caption", "Returned breakdown"));
    const head = element("thead");
    const headRow = element("tr");
    for (const column of answer.table.columns) {
      const cell = element("th", column.label, column.format && column.format !== "text" ? "number" : "");
      cell.scope = "col";
      headRow.append(cell);
    }
    head.append(headRow);
    table.append(head);
    const body = element("tbody");
    for (const row of answer.table.rows) {
      const tr = element("tr");
      for (const column of answer.table.columns) tr.append(element("td", formatValue(row[column.key], column.format, column.currency), column.format && column.format !== "text" ? "number" : ""));
      body.append(tr);
    }
    table.append(body);
    scroll.append(table);
    tablePanel.append(scroll);
    tablePanel.append(element("p", answer.table.rows.length
      ? `${answer.table.rows.length} returned rows · Amounts retain the API’s currency and metric definition. Missing values are not treated as zero.`
      : "No rows were returned. This is not evidence of zero losses or no fraud.", "table-note"));
    target.append(tablePanel);
    const details = element("div", undefined, "answer-details");
    for (const [title, values, fallback, ordered] of [
      ["Important context", answer.narrative.caveats, "No caveats were returned by the service.", false],
      ["Next investigation steps", answer.narrative.investigationSteps, "No investigation steps were returned by the service.", true]
    ]) {
      const panel = element("div", undefined, "panel");
      panel.append(element("h3", title), Array.isArray(values) && values.length ? list(values, ordered) : element("p", fallback, "small muted"));
      details.append(panel);
    }
    target.append(details, element("h3", "Definitions & citations"));
    if (answer.knowledge?.status === "available" && Array.isArray(answer.knowledge.sources) && answer.knowledge.sources.length) {
      target.append(renderSources(answer.knowledge.sources));
    } else {
      target.append(notice(answer.knowledge?.status === "available"
        ? "The knowledge service returned no citations for this answer."
        : "Knowledge evidence is unavailable or was not reported. Do not interpret this answer as definition-verified."));
    }
    const strip = element("div", undefined, "provenance-strip");
    strip.append(element("span", `Source as of ${formatTime(answer.provenance.sourceAsOf)}`), element("span", `Generated ${formatTime(answer.provenance.generatedAt)}`), element("span", `Trace ${text(answer.provenance.traceId)}`, "mono"));
    if (safeEvidenceUrl(answer.evidenceUrl)) {
      const inspect = button("Inspect evidence ↗", () => showEvidence(answer));
      inspect.dataset.evidenceButton = "";
      strip.append(inspect);
    } else {
      strip.append(element("span", "Evidence endpoint not supplied or invalid"));
    }
    target.append(strip);
  }
  function safeEvidenceUrl(url) {
    return typeof url === "string" && /^\/api\/evidence\/[A-Za-z0-9_-]+$/.test(url);
  }
  function renderPlannerExecution(provenance) {
    if (provenance?.mode === "guided") return element("p", "Guided request: no model was executed.", "small muted");
    const execution = provenance?.plannerExecution;
    if (!execution || typeof execution !== "object") return element("p", "Planner completion metadata not reported. A configured deployment label does not identify the model response.", "small muted");
    const details = element("details");
    details.append(element("summary", "Planner execution identity & hashes"));
    details.append(element("p", "Service-reported completion metadata, not an independently attested model version. Identifiers and hashes support traceability; identical model reruns are not guaranteed.", "small muted"));
    details.append(metadata([
      ["Service-reported model", execution.reportedModel], ["Configured model version", execution.configuredModelVersion],
      ["Completion ID", execution.completionId], ["Completion created", formatTime(execution.completionCreatedAt)],
      ["System fingerprint", execution.systemFingerprint ?? "Not supplied by service"], ["Provider", execution.provider],
      ["API version", execution.apiVersion], ["Prompt SHA-256", execution.promptSha256],
      ["Response schema SHA-256", execution.responseSchemaSha256], ["Question SHA-256", execution.questionSha256],
      ["Typed request SHA-256", execution.requestSha256], ["Model response SHA-256", execution.responseSha256],
      ["Temperature", execution.parameters?.temperature], ["Maximum output tokens", execution.parameters?.max_tokens]
    ]));
    return details;
  }
  async function showEvidence(answer) {
    if (!hasCapability("evidence") || !safeEvidenceUrl(answer.evidenceUrl)) return;
    const generation = openDialog("Inspect the evidence", "Answer provenance");
    const body = $("dialog-body");
    const provenance = answer.provenance;
    body.append(metadata([
      ["Answer", answer.answerId], ["Trace", provenance.traceId], ["Execution mode", provenance.mode],
      ["Source", provenance.sourceId], ["Source as of", formatTime(provenance.sourceAsOf)],
      ["Generated", formatTime(provenance.generatedAt)], ["Metric version", provenance.metricVersion],
      ["Broker response SHA-256", provenance.brokerResponseSha256],
      ["Template version", provenance.templateVersion], ["Prompt version", provenance.promptVersion],
      ["Model deployment", provenance.modelDeployment]
    ]));
    body.append(element("p", "Where returned, the broker response hash identifies the original approved broker payload stored in this evidence record, before additional web policy caveats. It is not independent SQL execution attestation.", "small muted"));
    body.append(renderPlannerExecution(provenance));
    const content = element("div");
    content.append(loading("Retrieving the full evidence record…"));
    body.append(content);
    try {
      const evidence = await request(answer.evidenceUrl);
      if (generation !== state.dialogGeneration || !$("detail-dialog").open) return;
      recordObservation("FI-04", `Evidence response received for answer ${text(answer.answerId)}. Compare the server JSON with that answer; retrieval alone does not validate its contents or retention.`);
      content.replaceChildren(element("h3", "Evidence snapshot"), element("p", "This is the stored API response, not a fresh policy decision. Compare its effective dates and policy-set version with any later lookup.", "small muted"));
      if (evidence.request?.current && evidence.request?.previous) content.append(element("p", periodLabel({ request: evidence.request }), "answer-periods"));
      if (evidence.answer?.knowledge) content.append(renderPolicyContext(evidence.answer.knowledge));
      content.append(element("h3", "Full server evidence"), element("p", "Download the unmodified evidence response to inspect the request, result, trace and included citations.", "small muted"));
      const json = JSON.stringify(evidence, null, 2);
      const pre = element("pre", json, "evidence-json");
      pre.tabIndex = 0;
      pre.setAttribute("aria-label", "Full evidence JSON");
      content.append(pre);
      const actions = element("div", undefined, "dialog-actions");
      actions.append(button("Download evidence ↓", () => downloadJson(json, `fraud-evidence-${answer.answerId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`), "button primary"));
      content.append(actions);
    } catch (error) {
      if (generation !== state.dialogGeneration || !$("detail-dialog").open) return;
      recordObservation("FI-04", `Evidence not retrieved: ${text(error.code)}. No substitute audit record or download is available.`);
      content.replaceChildren(errorPanel(error, "Full evidence is unavailable", () => showEvidence(answer)));
    }
  }
  function downloadJson(json, name) {
    const url = URL.createObjectURL(new Blob([json], { type: "application/json;charset=utf-8" }));
    const link = element("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  function structuredText(value) {
    if (value && typeof value === "object") return JSON.stringify(value);
    return text(value);
  }
  function scopeLabel(scope) {
    if (!scope || typeof scope !== "object" || Array.isArray(scope)) return text(scope, "Scope not returned");
    const parts = [
      ["Business unit", scope.businessUnit], ["Subject", scope.subject],
      ["Channel", scope.channel === "*" ? "all" : scope.channel],
      ["Province", scope.province === "*" ? "all" : scope.province]
    ].filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${text(value)}`);
    if (Array.isArray(scope.excludedChannels) && scope.excludedChannels.length) parts.push(`except channels ${scope.excludedChannels.map(value => text(value)).join(", ")}`);
    if (Array.isArray(scope.excludedProvinces) && scope.excludedProvinces.length) parts.push(`except provinces ${scope.excludedProvinces.map(value => text(value)).join(", ")}`);
    return parts.join(" · ") || "Scope not returned";
  }
  function policyReferenceDetails(record) {
    const entries = [
      ["Policy / version", record.policyId ? `${text(record.policyId)} / ${text(record.version)}` : undefined],
      ["Document", record.documentId], ["Effective from", record.effectiveFrom],
      ["Effective until (exclusive)", record.effectiveTo === null ? "Open-ended" : record.effectiveTo],
      ["Approval", record.approvalStatus], ["Approved at", record.approvedAt === null ? "Not approved" : record.approvedAt],
      ["Published at (not precedence)", record.publishedAt], ["Owner", record.owner],
      ["Scope", record.scope ? scopeLabel(record.scope) : undefined],
      ["Supersedes", Array.isArray(record.supersedes) ? record.supersedes.length
        ? record.supersedes.map(item => `${text(item.policyId)} / ${text(item.version)}`).join("; ")
        : "No supersession references returned" : undefined]
    ].filter(([, value]) => value !== undefined);
    return metadata(entries);
  }
  function jsonDetails(title, value) {
    const details = element("details");
    const pre = element("pre", JSON.stringify(value, null, 2), "evidence-json");
    pre.tabIndex = 0;
    pre.setAttribute("aria-label", title);
    details.append(element("summary", title), pre);
    return details;
  }
  function renderPolicyResolution(resolution) {
    const panel = element("section", undefined, "panel policy-resolution");
    const statuses = {
      resolved: ["Applicable policy resolved", "success"],
      conflict: ["Unresolved policy conflict", "danger"],
      "no-applicable-policy": ["No applicable policy", ""]
    };
    const status = statuses[resolution?.status];
    const heading = element("div", undefined, "section-heading");
    heading.append(element("h3", "Policy interpretation"), element("span", status?.[0] || "Resolution not reported", `pill ${status?.[1] || ""}`));
    panel.append(heading);
    if (!status) {
      panel.append(element("p", "Effective-dated policy resolution was not returned. Numerical broker results can still be inspected, but this is not a policy-verified interpretation.", "small muted"));
      return panel;
    }
    panel.dataset.policyStatus = resolution.status;
    if (resolution.status === "conflict") {
      const warning = element("div", undefined, "notice error");
      warning.setAttribute("role", "alert");
      warning.append(element("h3", "Interpretation withheld · broker figures remain available"),
        element("p", "The service could not select an unambiguous applicable policy. Do not resolve this by choosing the newest version."),
        element("p", "Ask the named policy owner to reconcile approval, scope and effective dates through the established review process. This read-only workspace cannot approve policies or send escalations."));
      panel.append(warning);
    } else if (resolution.status === "no-applicable-policy") {
      panel.append(notice("No authorized, applicable policy was resolved for this context. Check the effective date and scope with the policy owner before drawing a policy conclusion."));
    } else {
      panel.append(element("p", "The service resolved applicable policy for the context below. This does not establish causation or authorize a rule change.", "small muted"));
    }
    panel.append(metadata([
      [resolution.periods ? "Reporting periods" : "Applicable as of", resolution.periods ? periodLabel({ request: resolution.periods }) : resolution.asOf],
      ["Policy-set version", resolution.policySetVersion],
      ["Evaluated at", formatTime(resolution.evaluatedAt)],
      ...(resolution.snapshotHash ? [["Snapshot hash", resolution.snapshotHash]] : []),
      ...(resolution.registry ? [["Registry", resolution.registry]] : [])
    ]));
    for (const [key, label] of [["conflicts", "Unresolved conflicts"], ["decisions", "Policy decisions"]]) {
      if (!Array.isArray(resolution[key]) || !resolution[key].length) continue;
      const details = element("details", undefined, "resolution-decisions");
      details.open = key === "conflicts";
      details.append(element("summary", `${label} (${resolution[key].length})`));
      for (const record of resolution[key]) {
        if (!record || typeof record !== "object") continue;
        const item = element("div", undefined, "policy-decision");
        item.append(element("h3", text(record.title, text(record.policyId, text(record.subject, label)))));
        const entries = [["Status", record.status], ["Reason", record.reason], ["Scope", record.scope ? scopeLabel(record.scope) : undefined],
          ["Period", record.period ? `${text(record.period)} · ${text(record.start)} → ${text(record.end)} (exclusive)` : undefined]]
          .filter(([, value]) => value !== undefined).map(([label, value]) => [label, structuredText(value)]);
        if (entries.length) item.append(metadata(entries));
        if (record.version) item.append(policyReferenceDetails(record));
        if (Array.isArray(record.versions)) {
          for (const version of record.versions) {
            if (!version || typeof version !== "object") continue;
            item.append(element("h3", `Conflicting version ${text(version.version)}`), policyReferenceDetails(version));
          }
        }
        item.append(jsonDetails("Inspect returned decision metadata", record));
        details.append(item);
      }
      panel.append(details);
    }
    return panel;
  }
  function renderPolicyContext(knowledge) {
    const section = element("div", undefined, "policy-context");
    const resolution = knowledge?.policyResolution;
    section.append(renderPolicyResolution(resolution));
    if (resolution && knowledge?.status !== "available") {
      section.append(notice("Policy resolution metadata is present, but source retrieval is unavailable. Do not treat this as source-content verification."));
    }
    const coverage = renderSourceCoverage(knowledge?.sourceCoverage);
    if (coverage) section.append(coverage);
    if (Array.isArray(resolution?.segments) && resolution.segments.length) {
      const timeline = element("details", undefined, "panel policy-segments");
      timeline.append(element("summary", `Policy changes across reporting periods · ${resolution.segments.length} effective segments`),
        element("p", "Segments are returned by the policy service. Monthly numerical totals are not split or reattributed to individual policy versions.", "small muted"));
      for (const segment of resolution.segments) {
        if (!segment || typeof segment !== "object") continue;
        const block = element("section", undefined, "policy-segment");
        block.append(element("h3", `${text(segment.period)} · ${text(segment.start)} → ${text(segment.end)} (exclusive)`));
        block.append(renderPolicyResolution({ ...segment, asOf: segment.start, evaluatedAt: resolution.evaluatedAt, policySetVersion: resolution.policySetVersion }));
        timeline.append(block);
      }
      section.append(timeline);
    }
    return section;
  }
  function renderSourceCoverage(coverage) {
    if (!coverage || typeof coverage !== "object") return null;
    const { resolvedVersions, citedVersions, omittedResolvedVersions } = coverage;
    const countsValid = [resolvedVersions, citedVersions, omittedResolvedVersions]
      .every(value => Number.isSafeInteger(value) && value >= 0) &&
      citedVersions + omittedResolvedVersions === resolvedVersions;
    const panel = element("div", undefined, "source-coverage notice");
    panel.append(element("h3", "Source excerpt coverage"));
    panel.append(element("p", countsValid
      ? `${citedVersions} of ${resolvedVersions} resolved policy versions have returned excerpts. ${omittedResolvedVersions} resolved version${omittedResolvedVersions === 1 ? " is" : "s are"} not cited.`
      : "Complete, consistent excerpt-coverage counts were not returned. Missing counts are not treated as zero."));
    panel.append(element("p", coverage.allPolicyMetadataEvaluated === true
      ? "The service reports that all policy metadata was evaluated. Metadata decisions remain authoritative; a missing excerpt does not make a policy missing or inapplicable."
      : "Metadata-evaluation completeness was not confirmed. Inspect the returned policy decisions and source context.", "small muted"));
    if (Number.isSafeInteger(coverage.maxSources) && coverage.maxSources >= 0) {
      panel.append(element("p", `Service source limit: ${coverage.maxSources}. Source relevance and publication order do not determine policy precedence.`, "small muted"));
    }
    return panel;
  }
  async function loadPolicies(event) {
    event?.preventDefault();
    if (state.policyLoading || state.status?.synthetic !== true) return;
    const asOf = $("policy-date").value;
    if (!asOf) { $("policy-date").reportValidity(); return; }
    state.policyLoading = true;
    state.policyAttempted = true;
    state.policyError = null;
    state.policyRegister = null;
    state.policyAsOf = asOf;
    updateControls();
    $("policy-register").setAttribute("aria-busy", "true");
    $("policy-register").replaceChildren(loading("Retrieving authorized policy history…"));
    $("policy-availability").textContent = `Retrieving authorized metadata… Reference date ${asOf} is display context only.`;
    try {
      const result = await request("/api/policies");
      if (result.status !== "available" || result.synthetic !== true || !Array.isArray(result.policies)) {
        throw new ApiError("The service did not return an available authorized policy register. No local policy snapshot has been substituted.", { code: "POLICY_REGISTER_UNAVAILABLE" });
      }
      state.policyRegister = result;
      populatePolicySubjects(result.policies);
      renderPolicyRegister();
      $("policy-availability").textContent = "Authorized metadata received. Timeline date labels are local context only; definition search resolves applicability.";
    } catch (error) {
      state.policyError = error;
      $("policy-register").replaceChildren(errorPanel(error, "Policy register unavailable", loadPolicies));
      $("policy-availability").textContent = "Metadata unavailable. This is not an empty register or proof that no policy applies.";
    } finally {
      state.policyLoading = false;
      $("policy-register").removeAttribute("aria-busy");
      updateControls();
    }
  }
  function renderPolicyRegister() {
    const data = state.policyRegister;
    if (!data) return;
    const filter = $("policy-filter").value.trim().toLowerCase();
    const policies = data.policies.filter(policy => policy && typeof policy === "object");
    const visible = policies.filter(policy => JSON.stringify(policy).toLowerCase().includes(filter));
    const groups = new Map();
    for (const policy of visible) {
      const key = text(policy.policyId, text(policy.documentId, "Unidentified policy"));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(policy);
    }
    const summary = element("div", undefined, "policy-summary");
    summary.append(element("h3", `${groups.size} policy ${groups.size === 1 ? "family" : "families"} · ${visible.length} of ${policies.length} authorized versions`));
    summary.append(metadata([["Timeline reference date", state.policyAsOf], ["Policy-set version", data.policySetVersion], ["Metadata evaluated at", formatTime(data.evaluatedAt)], ["Registry", data.registry],
      ...(data.snapshotHash ? [["Snapshot hash", data.snapshotHash]] : [])]));
    summary.append(element("p", "Approved and date-eligible does not mean governing. Scoped exceptions and overlapping versions require a service-resolved decision below. Publication order is never policy precedence.", "small muted"));
    const target = $("policy-register");
    target.replaceChildren(summary);
    if (!visible.length) {
      target.append(notice(filter ? "No returned policy metadata matches this filter. Clear the filter to see the authorized register." : "The API returned an empty authorized policy register. No policy history has been fabricated."));
      return;
    }
    const families = element("div", undefined, "policy-register-list");
    for (const [policyId, versions] of groups) {
      const details = element("details", undefined, "policy-family");
      const heading = element("summary", policyId);
      heading.append(element("span", `${versions.length} version${versions.length === 1 ? "" : "s"}`, "pill"));
      details.append(heading);
      const body = element("div", undefined, "policy-family-body");
      const history = element("ol", undefined, "policy-timeline");
      versions.sort((a, b) => text(b.effectiveFrom, "").localeCompare(text(a.effectiveFrom, "")) || text(a.version).localeCompare(text(b.version)));
      for (const policy of versions) {
        const status = policyDateLabel(policy, state.policyAsOf);
        const version = element("li", undefined, status === "Approved · date-eligible" ? "applicable" : "");
        const top = element("div", undefined, "row between wrap");
        top.append(element("h3", `Version ${text(policy.version)}`), element("span", status, `pill${policy.approvalStatus === "approved" ? "" : " danger"}`));
        version.append(top, element("p", policy.title, "small"), policyReferenceDetails(policy));
        const outsideWindow = policy.effectiveFrom > state.policyAsOf || (policy.effectiveTo && state.policyAsOf >= policy.effectiveTo);
        const lookupDate = outsideWindow ? text(policy.effectiveFrom, state.policyAsOf).slice(0, 10) : state.policyAsOf;
        if (policy.approvalStatus === "approved") {
          const use = button(`Prepare definition search · ${lookupDate}`, () => preparePolicySearch({
            q: text(policy.policyId, text(policy.title)), asOf: lookupDate,
            subject: policy.scope?.subject,
            ...(policy.scope?.channel && policy.scope.channel !== "*" ? { channel: policy.scope.channel } : {}),
            ...(policy.scope?.province && policy.scope.province !== "*" ? { province: policy.scope.province } : {})
          }), "button quiet compact");
          use.dataset.exampleCapability = "knowledge";
          use.disabled = !analysisAllowed("knowledge") || state.searching;
          version.append(use);
        } else version.append(element("p", "Not approved for governing interpretation. Metadata only; no draft policy text is substituted.", "small muted"));
        history.append(version);
      }
      body.append(history, jsonDetails("Inspect returned version metadata", versions));
      details.append(body);
      families.append(details);
    }
    target.append(families);
    if (Array.isArray(data.scenarios) && data.scenarios.length) {
      const scenarios = element("details", undefined, "policy-scenarios");
      scenarios.append(element("summary", "Synthetic policy scenarios · optional"), element("p", "Service-provided descriptions, not observed outcomes. Selecting a scenario prepares the definition form; no request is sent until you choose Find definitions.", "small muted"));
      for (const scenario of data.scenarios) {
        if (!scenario || typeof scenario !== "object" || !scenario.query?.q || !scenario.query?.asOf) continue;
        const item = element("div", undefined, "policy-decision");
        item.append(element("h3", scenario.title), element("p", scenario.description, "small muted"));
        const action = button("Prepare this search", () => preparePolicySearch(scenario.query), "button quiet compact");
        action.dataset.exampleCapability = "knowledge";
        action.disabled = !analysisAllowed("knowledge") || state.searching;
        item.append(action);
        scenarios.append(item);
      }
      target.append(scenarios);
    }
    if (Array.isArray(data.limitations) && data.limitations.length) {
      const limitations = element("details", undefined, "policy-scenarios");
      limitations.append(element("summary", "Registry limitations reported by the service"), list(data.limitations));
      target.append(limitations);
    }
  }
  function policyDateLabel(policy, asOf) {
    if (policy.approvalStatus !== "approved") return policy.approvalStatus === "draft" ? "Draft · not approved" : policy.approvalStatus === "withdrawn" ? "Withdrawn" : "Approval not reported";
    const from = typeof policy.effectiveFrom === "string" ? policy.effectiveFrom.slice(0, 10) : "";
    const until = typeof policy.effectiveTo === "string" ? policy.effectiveTo.slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !asOf) return "Approved · date not verified";
    if (from > asOf) return "Future · approved";
    if (until && until <= asOf) return "Historical · approved";
    return "Approved · date-eligible";
  }
  function populatePolicySubjects(policies) {
    const select = $("knowledge-subject");
    const selected = select.value;
    select.replaceChildren(element("option", "Determine from search terms"));
    select.firstElementChild.value = "";
    const subjects = [...new Set(policies.map(policy => policy?.scope?.subject).filter(value => typeof value === "string"))].sort();
    for (const subject of subjects) {
      const option = element("option", subject);
      option.value = subject;
      select.append(option);
    }
    if (subjects.includes(selected)) select.value = selected;
  }
  function preparePolicySearch(query) {
    $("knowledge-query").value = text(query.q, "");
    $("knowledge-date").value = text(query.asOf, state.policyAsOf);
    for (const field of ["subject", "channel", "province"]) $(`knowledge-${field}`).value = text(query[field], "");
    $("knowledge-results").replaceChildren(notice(`Search prepared for ${$("knowledge-date").value}. Not submitted; choose Find definitions to retrieve the service-resolved policy and sources.`));
    $("knowledge-form").scrollIntoView({ block: "start", behavior: "auto" });
    $("knowledge-query").focus({ preventScroll: true });
  }
  function searchKnowledge(event) {
    event.preventDefault();
    if (state.searching || !analysisAllowed("knowledge")) return;
    if (!$("knowledge-form").reportValidity()) return;
    const query = $("knowledge-query").value.trim();
    const asOf = $("knowledge-date").value;
    if (!query) {
      const warning = notice("Enter a definition or rule before searching. No request was sent.");
      warning.setAttribute("role", "alert");
      $("knowledge-results").replaceChildren(warning);
      $("knowledge-query").focus();
      return;
    }
    const params = { q: query, asOf };
    for (const field of ["subject", "channel", "province"]) {
      if ($(`knowledge-${field}`).value) params[field] = $(`knowledge-${field}`).value;
    }
    return lookupKnowledge(Object.freeze(params));
  }
  async function lookupKnowledge(params) {
    if (state.searching || !analysisAllowed("knowledge")) return;
    const { q: query, asOf } = params;
    const requestScope = `Requested scope · ${params.subject ? `Subject: ${params.subject} · ` : ""}Channel: ${params.channel || "all authorized"} · Province: ${params.province || "all authorized"}`;
    state.searching = true;
    updateControls();
    $("knowledge-results").setAttribute("aria-busy", "true");
    $("knowledge-results").replaceChildren(loading("Looking up effective definitions…"));
    try {
      const result = await request(`/api/knowledge?${new URLSearchParams(params)}`);
      if (result.status !== "available" || !Array.isArray(result.sources)) {
        throw new ApiError("The knowledge service did not return available sources. No local definition has been substituted.", { code: "KNOWLEDGE_UNAVAILABLE" });
      }
      const heading = element("div", undefined, "section-heading");
      heading.append(element("h2", `${result.sources.length} source${result.sources.length === 1 ? "" : "s"} returned`), element("span", `Effective as of ${asOf}`, "small muted"));
      $("knowledge-results").replaceChildren(heading, element("p", `Query: “${query}” · Retrieval mode: ${text(result.mode)}`, "small muted"),
        element("p", requestScope, "small muted"), renderPolicyContext(result));
      if (result.mode === "hybrid") $("knowledge-results").append(notice("Hybrid results can include vector nearest neighbors, even without a literal term match. Inspect each excerpt; a returned neighbor is not proof that the requested rule or term was found."));
      $("knowledge-results").append(result.sources.length ? renderSources(result.sources) : notice(
        result.policyResolution?.status === "conflict"
          ? "No source excerpts are shown for this unresolved policy context. Review the conflict and version metadata above; do not substitute a local or historical policy."
          : result.policyResolution?.status === "no-applicable-policy"
            ? `No applicable approved policy was resolved for ${asOf} and the requested scope. An old version is not carried forward.`
            : `No accessible source excerpts matched “${query}” for ${asOf}. Try another term or effective date.`));
      recordObservation("FI-03", `API returned available with ${result.sources.length} source${result.sources.length === 1 ? "" : "s"} for “${query}” as of ${asOf} · ${text(result.mode)}. ${result.sources.length ? "Inspect the actual citations." : "An empty result was observed for this request, not an outage."}`);
    } catch (error) {
      const failure = errorPanel(error, "Definitions could not be retrieved", () => lookupKnowledge(params));
      failure.querySelector("button").dataset.exampleCapability = "knowledge";
      $("knowledge-results").replaceChildren(
        element("p", `Failed lookup · Query: “${query}” · Effective as of ${asOf}`, "small muted"),
        element("p", requestScope, "small muted"),
        element("p", "Try again repeats this lookup, not unsent form edits. Use Find definitions to submit a changed query.", "small muted"),
        failure);
      recordObservation("FI-03", `Lookup for “${query}” as of ${asOf} failed: ${text(error.code)}. This is not an observed empty result.`);
    } finally {
      state.searching = false;
      $("knowledge-results").removeAttribute("aria-busy");
      updateControls();
    }
  }
  function storyBlockers(story) {
    const blockers = [];
    if (state.status?.synthetic !== true) blockers.push("Synthetic-data status is not confirmed");
    for (const capability of story.requiredCapabilities || []) {
      const reason = capabilityReason(capability);
      if (reason) blockers.push(reason);
    }
    if (story.scenarioKind && !state.scenarios.some(scenario => scenario.request?.kind === story.scenarioKind)) {
      blockers.push("Required guided scenario is not available");
    }
    return blockers;
  }
  function recordObservation(storyId, message) {
    state.observations[storyId] = message;
    renderWalkthrough();
  }
  function navigate(hash, focusId) {
    state.routeFocus = focusId;
    if (location.hash === `#${hash}`) showPage({ type: "navigation" });
    else location.hash = `#${hash}`;
  }
  function storyDestination(story) {
    return { knowledge: "knowledge", question: "question", boundary: "boundary-checks", evidence: state.answer ? "analysis" : "guided" }[story.action] || "guided";
  }
  function startWalkthrough(index = 0) {
    const story = state.catalog?.stories[index];
    if (!story) return;
    state.activeStoryId = story.id;
    renderWalkthrough();
    navigate(storyDestination(story), "walkthrough");
  }
  function loadExample(example, capability, focus = true) {
    if (capability === "knowledge") {
      $("knowledge-query").value = example.query;
      $("knowledge-date").value = example.asOf;
      for (const field of ["subject", "channel", "province"]) $(`knowledge-${field}`).value = "";
      $("knowledge-results").replaceChildren(notice(`Example loaded: “${example.query}” as of ${example.asOf}. Not submitted; select Find definitions to request real sources.`));
      if (focus) $("knowledge-query").focus();
    } else {
      $("question-input").value = example.question;
      updateQuestionCount();
      if (focus) $("question-input").focus();
    }
  }
  function renderExamples() {
    for (const [targetId, capability, examples] of [
      ["knowledge-examples", "knowledge", [
        { label: "R017", query: "R017", asOf: "2026-09-30" },
        { label: "Net fraud loss", query: "Net fraud loss", asOf: "2026-09-30" }
      ]],
      ["question-examples", "naturalLanguage", supportedQuestions.slice(0, 2)]
    ]) {
      const target = $(targetId);
      target.replaceChildren(element("span", "Question starters · select to edit, not send", "small muted"));
      for (const example of examples) {
        const action = button(example.label, () => loadExample(example, capability), "button quiet compact");
        action.dataset.exampleCapability = capability;
        target.append(action);
      }
    }
  }
  function openStoryExercise(story) {
    if (!story || storyBlockers(story).length) return;
    if (story.action === "evidence" && state.answer && safeEvidenceUrl(state.answer.evidenceUrl)) {
      showEvidence(state.answer);
      return;
    }
    if (story.action === "knowledge" || story.action === "question") {
      const capability = story.action === "knowledge" ? "knowledge" : "naturalLanguage";
      const example = story.presenter.examples?.[0];
      if (example) loadExample(example, capability, false);
      navigate(storyDestination(story), story.action === "knowledge" ? "knowledge-query" : "question-input");
    } else if (story.action === "boundary") {
      navigate("boundary-checks", "boundary-case");
    } else {
      const index = state.scenarios.findIndex(scenario => scenario.request?.kind === story.scenarioKind);
      navigate("guided", index >= 0 ? `scenario-${index}` : "guided-title");
    }
  }
  function renderWalkthrough() {
    const story = state.catalog?.stories.find(item => item.id === state.activeStoryId);
    const panel = $("walkthrough");
    panel.hidden = !story;
    if (!story) return;
    const index = state.catalog.stories.indexOf(story);
    if (panel.dataset.storyId !== story.id) {
      panel.dataset.storyId = story.id;
      $("walkthrough-step").textContent = `Presenter walkthrough · ${index + 1} of ${state.catalog.stories.length} · ${story.id} · ${story.presenter.durationSeconds} sec`;
      $("walkthrough-title").textContent = story.title;
      $("walkthrough-question").textContent = `Ask: ${story.presenter.question}`;
      $("walkthrough-points").replaceChildren(...story.presenter.pointOut.map(value => element("li", value)));
      $("walkthrough-expected").replaceChildren(...story.presenter.expected.map(value => element("li", value)));
    }
    const blockers = storyBlockers(story);
    $("walkthrough-observation").textContent = `Observed in this browser session: ${state.observations[story.id] || "Not observed yet. Expected notes above are not API results; open the exercise and send the request."}`;
    $("walkthrough-availability").textContent = blockers.length ? `Blocked · ${blockers.join(" · ")}. You can still read the cues or move to another step.` : "Ready to exercise · readiness is not a passed check.";
    $("walkthrough-action").textContent = story.action === "evidence" && (!state.answer || !safeEvidenceUrl(state.answer.evidenceUrl))
      ? "Run a guided analysis first →" : story.actionLabel;
    $("walkthrough-action").disabled = blockers.length > 0 || state.analyzing || state.searching || state.checkingBoundary;
    $("walkthrough-previous").disabled = index === 0;
    $("walkthrough-next").textContent = index === state.catalog.stories.length - 1 ? "Return to overview →" : "Next step →";
  }
  function renderStories() {
    const target = $("stories-list");
    const opened = new Set([...target.querySelectorAll("details[open]")].map(node => node.dataset.storyId));
    target.replaceChildren();
    if (state.catalogError) {
      target.append(errorPanel(state.catalogError, "Story catalog could not be loaded", loadStories));
      $("stories-readiness").textContent = "Catalog unavailable";
      return;
    }
    if (!state.catalog) {
      target.append(element("p", "Loading the exercise catalog…", "muted"));
      return;
    }
    let readyCount = 0;
    for (const story of state.catalog.stories) {
      const blockers = storyBlockers(story);
      if (!blockers.length) readyCount += 1;
      const card = element("article", undefined, "panel story-card");
      const heading = element("div", undefined, "row between wrap");
      heading.append(element("span", `${story.id} · ${story.presenter.durationSeconds} sec`, "overline"), element("span", blockers.length ? "Blocked" : "Ready to exercise", blockers.length ? "pill" : "pill accent"));
      card.append(heading, element("h2", story.title), element("p", `Ask: ${story.presenter.question}`, "presenter-question"));
      if (blockers.length) card.append(element("p", blockers.join(" · "), "story-blockers"));
      const details = element("details");
      details.dataset.storyId = story.id;
      details.open = opened.has(story.id);
      details.append(element("summary", "Presenter cues, expected fixtures & acceptance"));
      details.append(element("p", `As ${text(story.asA)}, I want ${text(story.iWant)}, so that ${text(story.soThat)}.`, "small muted"));
      for (const [title, values, ordered] of [["What to point out", story.presenter.pointOut, false], ["Expected only — not live API results", story.presenter.expected, false], ["Steps", story.steps, true], ["Acceptance criteria", story.acceptanceCriteria, false], ["Dependencies", story.dependencies, false]]) {
        details.append(element("h3", title), list(Array.isArray(values) ? values : [], ordered));
      }
      card.append(details);
      const action = button("Present this step →", () => startWalkthrough(state.catalog.stories.indexOf(story)));
      action.setAttribute("aria-label", `Present ${story.id}: ${story.title}`);
      action.disabled = blockers.length > 0;
      card.append(action);
      target.append(card);
    }
    $("story-count").textContent = state.catalog.stories.length;
    $("stories-readiness").textContent = `${readyCount} of ${state.catalog.stories.length} ready to exercise · None automatically marked complete`;
    $("walkthrough-preflight").textContent = state.catalog.walkthrough.preflight;
    $("walkthrough-closing").textContent = state.catalog.walkthrough.closing;
  }
  async function loadStories() {
    state.catalogError = null;
    try {
      const catalog = await request("/user-stories.json");
      if (!catalog.walkthrough || !Array.isArray(catalog.stories) || catalog.stories.some(story =>
        !story || typeof story.id !== "string" || !Array.isArray(story.requiredCapabilities) ||
        typeof story.presenter?.question !== "string" || !Number.isFinite(story.presenter?.durationSeconds) ||
        !Array.isArray(story.presenter?.pointOut) || !Array.isArray(story.presenter?.expected))) {
        throw new ApiError("The story catalog has an unexpected shape.", { code: "INVALID_CATALOG" });
      }
      state.catalog = catalog;
    } catch (error) {
      state.catalog = null;
      state.catalogError = error;
    }
    renderStories();
    renderExamples();
    updateControls();
  }
  function boundaryPayload() {
    const payload = {
      kind: "loss_comparison", groupBy: "channel",
      current: { start: "2026-09-01", end: "2026-10-01" },
      previous: { start: "2026-08-01", end: "2026-09-01" }
    };
    const selected = $("boundary-case").value;
    if (selected === "unsupported") payload.groupBy = "customer";
    if (selected === "pii") payload.select = ["email", "accountNumber"];
    if (selected === "write") { payload.operation = "update"; payload.write = true; }
    return payload;
  }
  async function runBoundaryCheck(event) {
    event.preventDefault();
    if (!analysisAllowed("guided") || state.checkingBoundary) return;
    state.checkingBoundary = true;
    updateControls();
    const payload = boundaryPayload();
    $("boundary-result").replaceChildren(loading("Sending the selected invalid request to /api/analyze…"));
    try {
      const result = await request("/api/analyze", { method: "POST", body: JSON.stringify(payload) });
      const warning = errorPanel(new ApiError("The API accepted this invalid request. The expected rejection was NOT observed. Review server validation before considering this exercise complete.", { code: "UNEXPECTED_ACCEPTANCE" }), "Boundary check needs investigation");
      const detail = element("details");
      detail.append(element("summary", "Inspect unexpected response"), element("pre", JSON.stringify(result, null, 2), "evidence-json"));
      warning.append(detail);
      $("boundary-result").replaceChildren(warning);
      recordObservation("FI-05", "The API accepted an invalid request. Expected rejection was NOT observed; investigate the response below.");
    } catch (error) {
      const schemaRejection = error.status === 400 && error.code === "INVALID_REQUEST";
      const panel = errorPanel(error, schemaRejection ? "Request rejected by the API" : "Expected validation rejection not verified");
      panel.append(element("p", schemaRejection
        ? "An INVALID_REQUEST schema rejection was observed. Check its message and server trace against the acceptance criteria. This browser cannot verify database calls or writes."
        : "Access, usage-limit, connection, dependency, no-data, or cohort-suppression failures do not demonstrate input-policy enforcement.", "small"));
      $("boundary-result").replaceChildren(panel);
      recordObservation("FI-05", `${$("boundary-case").selectedOptions[0].textContent}: ${error.status ? `HTTP ${error.status} · ` : ""}${text(error.code)}. ${schemaRejection ? "Inspect the message and trace; database isolation is not established here." : "The expected schema rejection was not verified."}`);
    } finally {
      state.checkingBoundary = false;
      updateControls();
    }
  }
  function showPage(event) {
    setMenuOpen(false);
    const hash = location.hash.slice(1);
    if (hash === "main") { $("main").focus({ preventScroll: true }); return; }
    const page = ["knowledge", "documentation"].includes(hash) ? hash : ["stories", "boundary-checks"].includes(hash) ? "stories" : "investigate";
    for (const name of ["investigate", "knowledge", "stories", "documentation"]) $(`page-${name}`).hidden = name !== page;
    for (const anchor of document.querySelectorAll("[data-page]")) {
      if (anchor.dataset.page === page) anchor.setAttribute("aria-current", "page");
      else anchor.removeAttribute("aria-current");
    }
    const focusId = state.routeFocus || (["guided", "analysis", "question", "boundary-checks"].includes(hash) ? hash : `${page}-title`);
    state.routeFocus = null;
    const target = $(focusId);
    if (target && (event || focusId === "walkthrough" || ["guided", "analysis", "question", "boundary-checks"].includes(hash))) {
      if (!target.hasAttribute("tabindex") && !["BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) target.tabIndex = -1;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "start", behavior: "auto" });
    } else window.scrollTo({ top: 0, behavior: "auto" });
    if (page === "knowledge" && !state.policyAttempted && state.status?.synthetic === true) loadPolicies();
  }

  function setMenuOpen(open) {
    $("menu-toggle").setAttribute("aria-expanded", String(open));
    $("menu-toggle").setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    $("primary-nav").classList.toggle("is-open", open);
  }
  $("menu-toggle").addEventListener("click", () => setMenuOpen($("menu-toggle").getAttribute("aria-expanded") !== "true"));
  $("primary-nav").addEventListener("click", event => {
    if (event.target.closest("a")) {
      setMenuOpen(false);
      if (event.target.closest("a").hash === location.hash) showPage(event);
    }
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && $("menu-toggle").getAttribute("aria-expanded") === "true") {
      setMenuOpen(false);
      $("menu-toggle").focus();
    }
  });
  window.matchMedia("(max-width: 1000px)").addEventListener("change", () => setMenuOpen(false));
  $("theme-toggle").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme !== "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    $("theme-toggle").textContent = dark ? "Light theme" : "Dark theme";
    $("theme-toggle").setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  });
  $("theme-toggle").textContent = document.documentElement.dataset.theme === "dark" ? "Light theme" : "Dark theme";
  $("theme-toggle").setAttribute("aria-label", document.documentElement.dataset.theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
  $("refresh-status").addEventListener("click", refreshStatus);
  $("walkthrough-start").addEventListener("click", () => startWalkthrough());
  $("walkthrough-start-hero").addEventListener("click", () => startWalkthrough());
  $("walkthrough-action").addEventListener("click", () => openStoryExercise(state.catalog?.stories.find(story => story.id === state.activeStoryId)));
  $("walkthrough-previous").addEventListener("click", () => startWalkthrough(state.catalog.stories.findIndex(story => story.id === state.activeStoryId) - 1));
  $("walkthrough-next").addEventListener("click", () => {
    const next = state.catalog.stories.findIndex(story => story.id === state.activeStoryId) + 1;
    if (next < state.catalog.stories.length) startWalkthrough(next);
    else {
      state.activeStoryId = null;
      renderWalkthrough();
      navigate("stories", "stories-title");
    }
  });
  $("walkthrough-close").addEventListener("click", () => {
    state.activeStoryId = null;
    renderWalkthrough();
    navigate(location.hash.slice(1) || "investigate");
  });
  $("connection-open").addEventListener("click", connectionDetails);
  $("dialog-close").addEventListener("click", () => $("detail-dialog").close());
  $("detail-dialog").addEventListener("close", () => {
    state.dialogGeneration += 1;
    syncAssistantPresentation();
  });
  $("assistant-toggle").addEventListener("click", () => setAssistantOpen(!state.assistantOpen));
  for (const id of ["assistant-open-hero", "assistant-open-header"]) $(id).addEventListener("click", () => setAssistantOpen(true));
  $("assistant-close").addEventListener("click", () => setAssistantOpen(false));
  $("assistant-panel").addEventListener("cancel", event => { event.preventDefault(); setAssistantOpen(false); });
  $("assistant-panel").addEventListener("close", () => {
    if (!$("assistant-panel").open && state.assistantOpen) setAssistantOpen(false);
  });
  $("assistant-panel").addEventListener("click", event => {
    const panel = $("assistant-panel");
    const bounds = panel.getBoundingClientRect();
    if (assistantOverlay.matches && event.target === panel && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) setAssistantOpen(false);
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Tab" && state.assistantOpen && assistantOverlay.matches && !$("detail-dialog").open) {
      const controls = [...$("assistant-panel").querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"])')]
        .filter(node => node.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    if (event.key === "Escape" && state.assistantOpen && !assistantOverlay.matches && !$("detail-dialog").open) {
      event.preventDefault();
      setAssistantOpen(false);
    }
  });
  assistantOverlay.addEventListener("change", syncAssistantPresentation);
  $("ask-form").addEventListener("submit", submitQuestion);
  $("question-input").addEventListener("input", updateQuestionCount);
  $("question-input").addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) submitQuestion(event);
  });
  renderAssistantSuggestions();
  renderExamples();
  $("policy-form").addEventListener("submit", loadPolicies);
  $("policy-filter").addEventListener("input", renderPolicyRegister);
  $("policy-date").addEventListener("change", () => {
    const date = $("policy-date").value;
    if (!date) return;
    state.policyAsOf = date;
    renderPolicyRegister();
    if (state.policyRegister) $("policy-availability").textContent = `Timeline reference changed to ${date}; date labels recalculated from returned metadata. No new policy decision or content was requested.`;
  });
  $("knowledge-date").value = "2026-09-30";
  $("knowledge-form").addEventListener("submit", searchKnowledge);
  $("boundary-case").addEventListener("change", () => { $("boundary-payload").textContent = JSON.stringify(boundaryPayload(), null, 2); $("boundary-result").replaceChildren(); });
  $("boundary-form").addEventListener("submit", runBoundaryCheck);
  $("boundary-payload").textContent = JSON.stringify(boundaryPayload(), null, 2);
  window.addEventListener("hashchange", showPage);
  showPage();
  renderReadiness();
  Promise.allSettled([refreshStatus(), loadScenarios(), loadStories()]);
})();
