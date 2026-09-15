/**
 * Application Master Controller
 * Handles tab switching, live SSE execution progress, Aiven DB save, and modal preview.
 */

document.addEventListener("DOMContentLoaded", () => {
  // 1. Initialize Canvas
  const canvas = new GraphCanvas("graph-canvas");

  // 2. Initialize Controllers
  const wfConverter = new WorkflowConverterUI(canvas);
  const nodeConverter = new NodeConverterUI(canvas);

  // 3. Tab Switching
  const tabButtons = document.querySelectorAll(".tab-btn");
  const tabPanes = document.querySelectorAll(".tab-pane");

  tabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      tabButtons.forEach(b => b.classList.remove("active"));
      tabPanes.forEach(p => p.classList.remove("active"));

      btn.classList.add("active");
      const targetId = btn.getAttribute("data-tab");
      document.getElementById(targetId).classList.add("active");

      if (targetId === "tab-canvas") {
        setTimeout(() => canvas.render(), 30);
      }
    });
  });

  // 4. Node Palette: Add Node
  const btnAddNode = document.getElementById("btn-add-node");
  const paletteSelect = document.getElementById("node-palette-select");
  if (btnAddNode && paletteSelect) {
    btnAddNode.addEventListener("click", () => {
      const val = paletteSelect.value;
      if (val) {
        canvas.addNode(val, 120, 120);
      }
    });
  }

  // 5. Preset Loader
  const btnLoadPreset = document.getElementById("btn-load-preset");
  const presetSelect = document.getElementById("workflow-preset-select");
  if (btnLoadPreset && presetSelect) {
    btnLoadPreset.addEventListener("click", async () => {
      const presetName = presetSelect.value;
      try {
        const resp = await fetch(`/api/workflows/${presetName}`);
        if (resp.ok) {
          const wfData = await resp.json();
          canvas.loadWorkflowJSON(wfData);
        } else {
          alert("Failed to load preset workflow.");
        }
      } catch (err) {
        console.error(err);
      }
    });
  }

  // 6. Clear Canvas
  const btnClear = document.getElementById("btn-clear-canvas");
  if (btnClear) {
    btnClear.addEventListener("click", () => {
      if (confirm("Clear current canvas?")) {
        canvas.clear();
      }
    });
  }

  // 7. Save to Aiven Cloud Database
  const btnSaveDB = document.getElementById("btn-save-db");
  if (btnSaveDB) {
    btnSaveDB.addEventListener("click", async () => {
      const name = prompt("Enter a name for this workflow in Aiven DB:", "my_workflow");
      if (!name) return;

      const workflowJSON = canvas.exportWorkflowJSON();
      try {
        const resp = await fetch("/api/workflows", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name, graph_json: workflowJSON })
        });
        const res = await resp.json();
        if (res.success) {
          alert(`Workflow '${name}' saved successfully to Aiven cloud database!`);
        } else {
          alert(`Save error: ${res.error}`);
        }
      } catch (err) {
        alert(`Save failed: ${err.message}`);
      }
    });
  }

  // GitHub 1-Click Pull & Push
  const btnPullGit = document.getElementById("btn-pull-github");
  const btnPushGit = document.getElementById("btn-push-github");

  if (btnPullGit) {
    btnPullGit.addEventListener("click", async () => {
      btnPullGit.disabled = true;
      btnPullGit.textContent = "⏳ Pulling...";
      try {
        const resp = await fetch("/api/github/pull", { method: "POST" });
        const data = await resp.json();
        if (data.success) {
          alert(`✅ Synced from GitHub!\n\n${data.message}`);
        } else {
          alert(`❌ Pull failed:\n\n${data.error}`);
        }
      } catch (err) {
        alert(`❌ Pull error: ${err.message}`);
      } finally {
        btnPullGit.disabled = false;
        btnPullGit.textContent = "⬇️ Pull GitHub";
      }
    });
  }

  if (btnPushGit) {
    btnPushGit.addEventListener("click", async () => {
      btnPushGit.disabled = true;
      btnPushGit.textContent = "⏳ Pushing...";
      try {
        const resp = await fetch("/api/github/push", { method: "POST" });
        const data = await resp.json();
        if (data.success) {
          alert(`✅ Successfully pushed local changes to GitHub!\n\n${data.message}`);
        } else {
          alert(`❌ Push failed:\n\n${data.error}`);
        }
      } catch (err) {
        alert(`❌ Push error: ${err.message}`);
      } finally {
        btnPushGit.disabled = false;
        btnPushGit.textContent = "⬆️ Push GitHub";
      }
    });
  }

  // 8. Queue Execution & Live SSE Listener
  const btnQueue = document.getElementById("btn-queue");
  const statusSpinner = document.getElementById("status-spinner");
  const statusText = document.getElementById("status-text");
  const progressFill = document.getElementById("progress-fill");
  const vramVal = document.getElementById("vram-val");

  // Modal elements
  const modal = document.getElementById("media-modal");
  const modalBody = document.getElementById("modal-media-container");
  const modalDownload = document.getElementById("modal-download-link");
  const btnCloseModal = document.getElementById("btn-close-modal");

  if (btnCloseModal) {
    btnCloseModal.addEventListener("click", () => modal.classList.remove("active"));
  }

  if (btnQueue) {
    btnQueue.addEventListener("click", async () => {
      const workflowData = canvas.exportWorkflowJSON();
      if (Object.keys(workflowData).length === 0) {
        alert("The canvas is empty. Add some nodes or load a preset first!");
        return;
      }

      btnQueue.disabled = true;
      statusSpinner.style.display = "inline-block";
      statusText.textContent = "Submitting workflow to engine...";
      progressFill.style.width = "5%";

      try {
        const resp = await fetch("/api/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workflow: workflowData })
        });
        const data = await resp.json();

        if (!data.success) {
          throw new Error(data.error || "Execution failed.");
        }

        // Listen for live progress via Server-Sent Events (SSE)
        listenToProgress();

      } catch (err) {
        alert(`Execution error: ${err.message}`);
        btnQueue.disabled = false;
        statusSpinner.style.display = "none";
        statusText.textContent = "Engine Ready";
        progressFill.style.width = "0%";
      }
    });
  }

  // ------------------------------------------------------------------------
  // 9. Floating Draggable VRAM HUD Controller
  // ------------------------------------------------------------------------
  const vramHud = document.getElementById("vram-hud");
  const hudHeader = document.getElementById("vram-hud-header");
  const hudBody = document.getElementById("vram-hud-body");
  const btnToggleHud = document.getElementById("btn-toggle-hud-body");
  const btnPurgeVram = document.getElementById("btn-purge-vram");

  const hudGpuName = document.getElementById("hud-gpu-name");
  const hudMeterFill = document.getElementById("hud-meter-fill");
  const hudVramUsed = document.getElementById("hud-vram-used");
  const hudVramPercent = document.getElementById("hud-vram-percent");
  const hudStatAlloc = document.getElementById("hud-stat-allocated");
  const hudStatRes = document.getElementById("hud-stat-reserved");
  const hudStatFree = document.getElementById("hud-stat-free");

  // Collapse/Expand HUD
  if (btnToggleHud && hudBody) {
    btnToggleHud.addEventListener("click", (e) => {
      e.stopPropagation();
      hudBody.classList.toggle("collapsed");
      btnToggleHud.textContent = hudBody.classList.contains("collapsed") ? "+" : "−";
    });
  }

  // Manual VRAM Purge
  if (btnPurgeVram) {
    btnPurgeVram.addEventListener("click", async (e) => {
      e.stopPropagation();
      btnPurgeVram.disabled = true;
      btnPurgeVram.textContent = "⏳...";
      try {
        const resp = await fetch("/api/purge-vram", { method: "POST" });
        const data = await resp.json();
        if (data.vram) {
          updateVramHUD(data.vram);
        }
      } catch (err) {
        console.error("Purge error:", err);
      } finally {
        btnPurgeVram.disabled = false;
        btnPurgeVram.textContent = "🧹 Purge";
      }
    });
  }

  // Dragging logic for floating HUD
  if (vramHud && hudHeader) {
    let isDraggingHud = false;
    let hudOffset = { x: 0, y: 0 };

    hudHeader.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      isDraggingHud = true;
      vramHud.classList.add("dragging");
      const rect = vramHud.getBoundingClientRect();
      hudOffset.x = e.clientX - rect.left;
      hudOffset.y = e.clientY - rect.top;
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!isDraggingHud) return;
      const parentRect = vramHud.parentElement.getBoundingClientRect();
      let newX = e.clientX - parentRect.left - hudOffset.x;
      let newY = e.clientY - parentRect.top - hudOffset.y;

      // Constrain within canvas viewport
      newX = Math.max(10, Math.min(newX, parentRect.width - vramHud.offsetWidth - 10));
      newY = Math.max(10, Math.min(newY, parentRect.height - vramHud.offsetHeight - 10));

      vramHud.style.left = `${newX}px`;
      vramHud.style.top = `${newY}px`;
      vramHud.style.right = "auto";
    });

    window.addEventListener("mouseup", () => {
      if (isDraggingHud) {
        isDraggingHud = false;
        vramHud.classList.remove("dragging");
      }
    });
  }

  function updateVramHUD(vram) {
    if (!vram) return;
    const alloc = vram.allocated_gb || 0;
    const total = vram.total_gb || 15;
    const res = vram.reserved_gb || alloc;
    const free = vram.free_gb !== undefined ? vram.free_gb : Math.max(0, +(total - alloc).toFixed(2));
    const device = vram.device || "NVIDIA Tesla T4";
    const pct = Math.min(100, Math.round((alloc / (total || 1)) * 100));

    if (vramVal) vramVal.textContent = `${alloc} / ${total} GB`;
    if (hudGpuName) hudGpuName.textContent = `${device} (${total} GB)`;
    if (hudMeterFill) {
      hudMeterFill.style.width = `${pct}%`;
      // Color shifts: green -> amber -> red
      if (pct > 85) {
        hudMeterFill.style.background = "#ef4444";
      } else if (pct > 65) {
        hudMeterFill.style.background = "linear-gradient(90deg, #10b981, #f59e0b)";
      } else {
        hudMeterFill.style.background = "linear-gradient(90deg, #10b981 0%, #38bdf8 100%)";
      }
    }
    if (hudVramUsed) hudVramUsed.textContent = `${alloc} GB Used`;
    if (hudVramPercent) hudVramPercent.textContent = `${pct}%`;
    if (hudStatAlloc) hudStatAlloc.textContent = `${alloc} GB`;
    if (hudStatRes) hudStatRes.textContent = `${res} GB`;
    if (hudStatFree) hudStatFree.textContent = `${free} GB`;
  }

  // ------------------------------------------------------------------------
  // 10. PayloadDiffEngine Inspector Drawer Controller
  // ------------------------------------------------------------------------
  const inspectorPanel = document.getElementById("inspector-panel");
  const btnToggleInspector = document.getElementById("btn-toggle-inspector");
  const btnCloseInspector = document.getElementById("btn-close-inspector");
  const inspectorNodeSelect = document.getElementById("inspector-node-select");
  const toggleDelta = document.getElementById("toggle-delta");
  const toggleCumulative = document.getElementById("toggle-cumulative");
  const metaNodeName = document.getElementById("meta-node-name");
  const metaDiffMode = document.getElementById("meta-diff-mode");
  const inspectorJsonDisplay = document.getElementById("inspector-json-display");

  let currentInspectionReport = [];
  let currentDiffMode = "delta"; // "delta" | "cumulative"

  if (btnToggleInspector && inspectorPanel) {
    btnToggleInspector.addEventListener("click", () => {
      inspectorPanel.classList.toggle("open");
      if (inspectorPanel.classList.contains("open")) {
        fetchInspectionReport();
      }
    });
  }

  if (btnCloseInspector && inspectorPanel) {
    btnCloseInspector.addEventListener("click", () => {
      inspectorPanel.classList.remove("open");
    });
  }

  if (toggleDelta && toggleCumulative) {
    toggleDelta.addEventListener("click", () => {
      currentDiffMode = "delta";
      toggleDelta.classList.add("active");
      toggleCumulative.classList.remove("active");
      metaDiffMode.textContent = "Isolated Delta";
      metaDiffMode.style.color = "#38bdf8";
      renderInspectionView();
    });

    toggleCumulative.addEventListener("click", () => {
      currentDiffMode = "cumulative";
      toggleCumulative.classList.add("active");
      toggleDelta.classList.remove("active");
      metaDiffMode.textContent = "Cumulative Full";
      metaDiffMode.style.color = "#10b981";
      renderInspectionView();
    });
  }

  if (inspectorNodeSelect) {
    inspectorNodeSelect.addEventListener("change", () => {
      renderInspectionView();
    });
  }

  async function fetchInspectionReport() {
    try {
      const resp = await fetch("/api/inspect");
      const data = await resp.json();
      currentInspectionReport = data.nodes || [];

      inspectorNodeSelect.innerHTML = "";
      if (currentInspectionReport.length === 0) {
        inspectorNodeSelect.innerHTML = '<option value="">-- No executed nodes to inspect --</option>';
        inspectorJsonDisplay.textContent = "// Run a workflow to inspect node output tensors";
        metaNodeName.textContent = "None";
        return;
      }

      currentInspectionReport.forEach((nodeItem, idx) => {
        const opt = document.createElement("option");
        opt.value = nodeItem.node_id;
        opt.textContent = `[#${nodeItem.node_id}] ${nodeItem.class_type}`;
        if (idx === currentInspectionReport.length - 1) {
          opt.selected = true; // Select latest node by default
        }
        inspectorNodeSelect.appendChild(opt);
      });

      renderInspectionView();
    } catch (err) {
      console.error("Failed to fetch inspection report:", err);
    }
  }

  function renderInspectionView() {
    const selectedId = inspectorNodeSelect.value;
    if (!selectedId) return;

    const nodeItem = currentInspectionReport.find(n => n.node_id === selectedId);
    if (!nodeItem) return;

    metaNodeName.textContent = `${nodeItem.class_type} [#${nodeItem.node_id}]`;

    const payload = currentDiffMode === "delta" ? nodeItem.isolated_delta : nodeItem.cumulative_full;
    inspectorJsonDisplay.textContent = JSON.stringify(payload, null, 2);
  }

  function showMediaModal(url) {
    if (!modalBody) return;
    modalBody.innerHTML = "";
    if (url.endsWith(".mp4")) {
      const vid = document.createElement("video");
      vid.src = url;
      vid.controls = true;
      vid.autoplay = true;
      vid.loop = true;
      modalBody.appendChild(vid);
    } else {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "Generated output";
      modalBody.appendChild(img);
    }
    if (modalDownload) modalDownload.href = url;
    if (modal) modal.classList.add("active");
  }

  function listenToProgress() {
    const evtSource = new EventSource("/api/progress");

    evtSource.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);

        if (msg.vram) {
          updateVramHUD(msg.vram);
        }

        if (msg.event === "node_started") {
          statusText.textContent = `Running [Step ${msg.step}/${msg.total_steps}]: ${msg.class_type}`;
          const pct = Math.round((msg.step / msg.total_steps) * 90);
          progressFill.style.width = `${pct}%`;
          canvas.setExecutingNode(msg.node_id);
        }

        if (msg.event === "completed") {
          evtSource.close();
          btnQueue.disabled = false;
          statusSpinner.style.display = "none";
          statusText.textContent = `Execution Complete in ${msg.duration_seconds}s!`;
          progressFill.style.width = "100%";
          canvas.setExecutingNode(null);

          // Update PayloadDiff inspector report automatically
          fetchInspectionReport();

          // Show generated media modal
          if (msg.saved_files && msg.saved_files.length > 0) {
            const mediaUrl = msg.saved_files[0];
            showMediaModal(mediaUrl);
          }
        }

        if (msg.event === "failed") {
          evtSource.close();
          btnQueue.disabled = false;
          statusSpinner.style.display = "none";
          statusText.textContent = `Execution Failed: ${msg.error}`;
          progressFill.style.width = "0%";
          canvas.setExecutingNode(null);
        }
      } catch (err) {
        console.error("SSE parse error:", err);
      }
    };

    evtSource.onerror = () => {
      evtSource.close();
      btnQueue.disabled = false;
      statusSpinner.style.display = "none";
    };
  }


  // Initial VRAM Poll
  fetch("/api/vram")
    .then(r => r.json())
    .then(data => updateVramHUD(data))
    .catch(() => {});

  // Load default preset on startup
  if (btnLoadPreset) btnLoadPreset.click();

  // ========================================================================
  // TOAST NOTIFICATION HELPER
  // ========================================================================
  const toastContainer = (() => {
    let el = document.getElementById("toast-container");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast-container";
      el.className = "toast-container";
      document.body.appendChild(el);
    }
    return el;
  })();

  function showToast(message, type = "info", durationMs = 3000) {
    const t = document.createElement("div");
    t.className = `toast ${type}`;
    t.textContent = message;
    toastContainer.appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity 0.3s"; }, durationMs - 300);
    setTimeout(() => t.remove(), durationMs);
  }

  // ========================================================================
  // TAB OPEN HOOKS — fire controllers when a tab is first activated
  // ========================================================================
  let logsTabInitialized = false;
  let dbTabInitialized   = false;
  let envTabInitialized  = false;

  // Override tab switching to fire lazy controllers
  tabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-tab");

      if (targetId === "tab-logs" && !logsTabInitialized) {
        logsTabInitialized = true;
        initLogsTab();
      }
      if (targetId === "tab-hierarchy") {
        initHierarchyTab();
      }
      if (targetId === "tab-database" && !dbTabInitialized) {
        dbTabInitialized = true;
        loadDatabaseStatus();
      }
      if (targetId === "tab-secrets" && !envTabInitialized) {
        envTabInitialized = true;
        loadEnvSecrets();
      }
    });
  });

  // ========================================================================
  // 11. VISUAL LOGS TAB — SSE Terminal + Execution History
  // ========================================================================
  const terminalBody    = document.getElementById("terminal-content");
  const terminalStatus  = document.getElementById("terminal-live-status");
  const btnClearLogs    = document.getElementById("btn-clear-logs");
  const btnRefreshHist  = document.getElementById("btn-refresh-history");
  const historySelect   = document.getElementById("history-workflow-select");
  const historyCards    = document.getElementById("history-cards-container");

  let logSseSource = null;

  function logLine(text, cls = "log-info") {
    if (!terminalBody) return;
    const now = new Date();
    const ts = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`;
    const line = document.createElement("div");
    line.className = `log-line ${cls}`;
    line.innerHTML = `<span class="log-ts">${ts}</span><span>${escapeHtml(text)}</span>`;
    terminalBody.appendChild(line);
    terminalBody.scrollTop = terminalBody.scrollHeight;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function initLogsTab() {
    logLine("Studio connected — streaming live execution events...", "log-system");
    if (logSseSource) logSseSource.close();

    logSseSource = new EventSource("/api/progress");
    logSseSource.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.event === "node_started") {
          logLine(`▶ Node [#${msg.node_id}] ${msg.class_type}  (step ${msg.step}/${msg.total_steps})`, "log-info");
        } else if (msg.event === "completed") {
          logLine(`✅ Execution complete — ${msg.duration_seconds}s`, "log-success");
          if (terminalStatus) { terminalStatus.textContent = "IDLE"; terminalStatus.style.color = "#4ade80"; }
        } else if (msg.event === "failed") {
          logLine(`❌ Execution failed: ${msg.error}`, "log-error");
          if (terminalStatus) { terminalStatus.textContent = "ERROR"; terminalStatus.style.color = "#f87171"; }
        } else if (msg.event === "progress") {
          logLine(msg.message || JSON.stringify(msg), "log-muted");
        }
        if (msg.vram) {
          logLine(`📊 VRAM: ${msg.vram.allocated_gb}GB / ${msg.vram.total_gb}GB`, "log-muted");
        }
      } catch (_) {}
    };
    logSseSource.onerror = () => {
      logLine("SSE stream disconnected.", "log-warn");
      if (terminalStatus) terminalStatus.textContent = "DISCONNECTED";
    };
  }

  if (btnClearLogs) {
    btnClearLogs.addEventListener("click", () => {
      if (terminalBody) terminalBody.innerHTML = "";
      logLine("Terminal cleared.", "log-muted");
    });
  }

  if (btnRefreshHist && historyCards) {
    btnRefreshHist.addEventListener("click", loadHistory);
  }

  async function loadHistory() {
    if (!historyCards) return;
    const wfName = historySelect ? historySelect.value : "flux_txt2img";
    historyCards.innerHTML = `<div class="placeholder-card">Loading history for <strong>${escapeHtml(wfName)}</strong>…</div>`;
    try {
      const resp = await fetch(`/api/history/${encodeURIComponent(wfName)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const runs = data.runs || [];
      if (runs.length === 0) {
        historyCards.innerHTML = `<div class="placeholder-card">No execution history found for <strong>${escapeHtml(wfName)}</strong>.</div>`;
        return;
      }
      historyCards.innerHTML = "";
      runs.forEach(run => {
        const card = document.createElement("div");
        card.className = "history-card";
        const statusClass = run.status === "success" ? "log-success" : "log-error";
        const statusIcon  = run.status === "success" ? "✅" : "❌";
        card.innerHTML = `
          <div class="history-title-row">
            <span class="font-mono" style="font-size:11px;color:#94a3b8;">#${escapeHtml(String(run.id || "—"))}</span>
            <span class="${statusClass}" style="font-size:11px;font-weight:600;">${statusIcon} ${escapeHtml(run.status || "unknown")}</span>
          </div>
          <div style="font-size:11px;color:#cbd5e1;">${escapeHtml(run.workflow_name || wfName)}</div>
          <div style="font-size:10.5px;color:#4b5563;">${escapeHtml(run.executed_at || run.timestamp || "")}</div>
          ${run.duration_seconds != null ? `<div style="font-size:10.5px;color:#6b7280;">⏱ ${run.duration_seconds}s</div>` : ""}
        `;
        historyCards.appendChild(card);
      });
    } catch (err) {
      historyCards.innerHTML = `<div class="placeholder-card" style="color:#f87171;">Failed to load history: ${escapeHtml(err.message)}</div>`;
    }
  }

  // ========================================================================
  // 12. WORKFLOWS HIERARCHY TAB — Search, Toggles, Run, Edit
  // ========================================================================
  const hierarchySearchInput = document.getElementById("hierarchy-search-input");
  const hierarchyTableBody   = document.getElementById("hierarchy-tbody");
  const pillActive           = document.getElementById("pill-active-count");
  const pillInactive         = document.getElementById("pill-inactive-count");

  function initHierarchyTab() {
    loadHierarchyWorkflows();
  }

  async function loadHierarchyWorkflows() {
    if (!hierarchyTableBody) return;
    try {
      const resp = await fetch("/api/workflows");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      renderHierarchyTable(data.workflows || []);
    } catch (err) {
      if (hierarchyTableBody) {
        hierarchyTableBody.innerHTML = `<tr><td colspan="6" style="padding:20px;text-align:center;color:#f87171;">Failed to load workflows: ${escapeHtml(err.message)}</td></tr>`;
      }
    }
  }

  function renderHierarchyTable(workflows) {
    if (!hierarchyTableBody) return;
    hierarchyTableBody.innerHTML = "";

    const query = hierarchySearchInput ? hierarchySearchInput.value.toLowerCase() : "";
    const filtered = workflows.filter(wf =>
      !query || (wf.name || "").toLowerCase().includes(query) || (wf.description || "").toLowerCase().includes(query)
    );

    let activeCount = 0, inactiveCount = 0;

    filtered.forEach((wf, idx) => {
      const isActive = wf.active !== false;
      if (isActive) activeCount++; else inactiveCount++;

      const tagBadge = wf.role === "master"
        ? `<span class="tag-badge-master">MASTER</span>`
        : wf.role === "selected"
          ? `<span class="tag-badge-selected">SELECTED</span>`
          : `<span class="tag-badge-sub">SUB</span>`;

      const isParent = !wf.parent_id;
      const rowClass = isParent ? "parent-row" : "sub-row";
      const prefix   = isParent ? "" : `<span class="tree-branch">└</span>`;

      const tr = document.createElement("tr");
      tr.className = `wf-row ${rowClass}`;
      tr.dataset.wfName = wf.name || "";
      tr.innerHTML = `
        <td><span class="row-index"><span class="idx-badge">${idx + 1}</span></span></td>
        <td>
          <div class="wf-meta-title">
            <span class="wf-title-text">${prefix}${escapeHtml(wf.name || "Unnamed")}</span>
            ${wf.description ? `<span class="wf-desc-text">${escapeHtml(wf.description)}</span>` : ""}
          </div>
        </td>
        <td>${tagBadge}</td>
        <td>
          <label class="switch">
            <input type="checkbox" class="wf-active-toggle" data-name="${escapeHtml(wf.name || "")}" ${isActive ? "checked" : ""}>
            <span class="slider"></span>
          </label>
        </td>
        <td><span class="font-mono" style="font-size:10.5px;color:#4b5563;">${escapeHtml(wf.updated_at || wf.created_at || "—")}</span></td>
        <td>
          <div class="actions-cell">
            <button class="btn-action btn-action-run" data-name="${escapeHtml(wf.name || "")}">▶ Run</button>
            <button class="btn-action btn-action-edit" data-name="${escapeHtml(wf.name || "")}">✎ Edit</button>
          </div>
        </td>
      `;
      hierarchyTableBody.appendChild(tr);
    });

    // Update pills
    if (pillActive) pillActive.textContent = `${activeCount} Active`;
    if (pillInactive) pillInactive.textContent = `${inactiveCount} Inactive`;

    // Wire toggle switches
    hierarchyTableBody.querySelectorAll(".wf-active-toggle").forEach(chk => {
      chk.addEventListener("change", async (e) => {
        const name = e.target.dataset.name;
        const active = e.target.checked;
        try {
          await fetch(`/api/workflows/${encodeURIComponent(name)}/active`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ active })
          });
          showToast(`${name}: ${active ? "Activated" : "Deactivated"}`, active ? "success" : "info");
          loadHierarchyWorkflows();
        } catch (err) {
          showToast(`Toggle failed: ${err.message}`, "error");
          e.target.checked = !active; // revert
        }
      });
    });

    // Wire Run buttons
    hierarchyTableBody.querySelectorAll(".btn-action-run").forEach(btn => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.name;
        try {
          const resp = await fetch(`/api/workflows/${encodeURIComponent(name)}`);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const wfData = await resp.json();
          canvas.loadWorkflowJSON(wfData);
          // Switch to canvas tab and queue execution
          const canvasTabBtn = document.querySelector('.tab-btn[data-tab="tab-canvas"]');
          if (canvasTabBtn) canvasTabBtn.click();
          setTimeout(() => { if (btnQueue) btnQueue.click(); }, 200);
          showToast(`▶ Running: ${name}`, "success");
        } catch (err) {
          showToast(`Run failed: ${err.message}`, "error");
        }
      });
    });

    // Wire Edit buttons
    hierarchyTableBody.querySelectorAll(".btn-action-edit").forEach(btn => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.name;
        try {
          const resp = await fetch(`/api/workflows/${encodeURIComponent(name)}`);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const wfData = await resp.json();
          canvas.loadWorkflowJSON(wfData);
          const canvasTabBtn = document.querySelector('.tab-btn[data-tab="tab-canvas"]');
          if (canvasTabBtn) canvasTabBtn.click();
          showToast(`✎ Loaded for editing: ${name}`, "info");
        } catch (err) {
          showToast(`Load failed: ${err.message}`, "error");
        }
      });
    });
  }

  if (hierarchySearchInput) {
    hierarchySearchInput.addEventListener("input", () => {
      // Re-render with filter — we rely on the cached DOM to re-filter
      loadHierarchyWorkflows();
    });
  }

  // ========================================================================
  // 13. AIVEN POSTGRESQL TAB — DB Status + Sync
  // ========================================================================
  const dbStatusDot     = document.getElementById("db-status-dot");
  const dbLatencyVal    = document.getElementById("db-latency-val");
  const dbVersionVal    = document.getElementById("db-version-val");
  const dbWfCount       = document.getElementById("db-wf-count");
  const dbLogsCount     = document.getElementById("db-logs-count");
  const dbWfList        = document.getElementById("db-wf-list");
  const btnSyncDb       = document.getElementById("btn-sync-database");
  const btnTestConn     = document.getElementById("btn-test-connection");
  const dbDiagList      = document.getElementById("db-diag-list");

  async function loadDatabaseStatus() {
    try {
      const resp = await fetch("/api/db/status");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      // Connection status dot
      const connected = data.connected !== false;
      if (dbStatusDot) {
        dbStatusDot.className = connected ? "dot-large-green" : "";
        if (!connected) {
          dbStatusDot.style.cssText = "width:12px;height:12px;border-radius:50%;background:#ef4444;display:inline-block;";
        }
      }

      if (dbLatencyVal) dbLatencyVal.textContent = data.latency_ms != null ? `${data.latency_ms}ms` : "—";
      if (dbVersionVal) dbVersionVal.textContent = data.pg_version || "—";
      if (dbWfCount)    dbWfCount.textContent    = data.workflow_count ?? "—";
      if (dbLogsCount)  dbLogsCount.textContent  = data.log_count ?? "—";

      // Workflow list
      if (dbWfList && Array.isArray(data.workflows)) {
        dbWfList.innerHTML = "";
        if (data.workflows.length === 0) {
          dbWfList.innerHTML = `<li style="color:#4b5563;font-style:italic;">No workflows stored yet.</li>`;
        } else {
          data.workflows.forEach(wf => {
            const li = document.createElement("li");
            li.innerHTML = `
              <span>${escapeHtml(wf.name || "—")}</span>
              <span class="font-mono" style="font-size:10px;color:#6b7280;">${escapeHtml(wf.updated_at || "")}</span>
            `;
            dbWfList.appendChild(li);
          });
        }
      }

      // Diagnostics
      if (dbDiagList) {
        const diagItems = [
          { label: "Host",        val: data.host || "—" },
          { label: "Database",    val: data.database || "—" },
          { label: "SSL",         val: data.ssl ? "✅ Enabled" : "—" },
          { label: "PG Version",  val: data.pg_version || "—" },
          { label: "Latency",     val: data.latency_ms != null ? `${data.latency_ms}ms` : "—" },
          { label: "Workflows",   val: data.workflow_count ?? "—" },
          { label: "Log Rows",    val: data.log_count ?? "—" },
        ];
        dbDiagList.innerHTML = "";
        diagItems.forEach(({ label, val }) => {
          const div = document.createElement("div");
          div.className = "diag-item";
          div.innerHTML = `<span class="diag-label">${escapeHtml(label)}</span><span class="diag-val">${escapeHtml(String(val))}</span>`;
          dbDiagList.appendChild(div);
        });
      }
    } catch (err) {
      if (dbStatusDot) {
        dbStatusDot.style.cssText = "width:12px;height:12px;border-radius:50%;background:#ef4444;display:inline-block;";
      }
      showToast(`DB status error: ${err.message}`, "error");
    }
  }

  if (btnSyncDb) {
    btnSyncDb.addEventListener("click", async () => {
      btnSyncDb.disabled = true;
      btnSyncDb.textContent = "⏳ Syncing…";
      try {
        const resp = await fetch("/api/db/sync", { method: "POST" });
        const data = await resp.json();
        if (data.success) {
          showToast(`✅ Sync complete — ${data.synced ?? 0} workflows synced`, "success");
          loadDatabaseStatus();
        } else {
          showToast(`Sync failed: ${data.error}`, "error");
        }
      } catch (err) {
        showToast(`Sync error: ${err.message}`, "error");
      } finally {
        btnSyncDb.disabled = false;
        btnSyncDb.textContent = "⟳ Sync Database";
      }
    });
  }

  if (btnTestConn) {
    btnTestConn.addEventListener("click", async () => {
      btnTestConn.disabled = true;
      btnTestConn.textContent = "⏳ Testing…";
      try {
        await loadDatabaseStatus();
        showToast("✅ Connection test passed", "success");
      } catch (err) {
        showToast(`Connection test failed: ${err.message}`, "error");
      } finally {
        btnTestConn.disabled = false;
        btnTestConn.textContent = "Test Connection";
      }
    });
  }

  // ========================================================================
  // 14. SECRETS & ENV TAB — Fetch, Masked Display, Save
  // ========================================================================
  const envBadge       = document.getElementById("env-status-badge");
  const btnSaveEnv     = document.getElementById("btn-save-env");
  const btnReloadEnv   = document.getElementById("btn-reload-env");

  // Known env field IDs mapped to their .env keys
  const ENV_FIELD_MAP = {
    "env-db-url":         "DATABASE_URL",
    "env-r2-account":     "R2_ACCOUNT_ID",
    "env-r2-access":      "R2_ACCESS_KEY_ID",
    "env-r2-secret":      "R2_SECRET_ACCESS_KEY",
    "env-r2-bucket":      "R2_BUCKET_NAME",
    "env-hf-token":       "HF_TOKEN",
    "env-gh-token":       "GITHUB_TOKEN",
    "env-cf-tunnel":      "CF_TUNNEL_TOKEN",
  };

  async function loadEnvSecrets() {
    try {
      const resp = await fetch("/api/env");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const envMap = data.env || {};

      let filledCount = 0;
      let totalCount  = Object.keys(ENV_FIELD_MAP).length;

      Object.entries(ENV_FIELD_MAP).forEach(([fieldId, envKey]) => {
        const input = document.getElementById(fieldId);
        if (input) {
          const val = envMap[envKey] || "";
          input.value = val;
          if (val && !val.startsWith("****")) filledCount++;
        }
      });

      // Update badge
      if (envBadge) {
        if (filledCount === totalCount) {
          envBadge.textContent = "✅ All Set";
          envBadge.className = "env-status-badge ok";
        } else if (filledCount === 0) {
          envBadge.textContent = "⚠ No Secrets";
          envBadge.className = "env-status-badge missing";
        } else {
          envBadge.textContent = `⚡ ${filledCount}/${totalCount} Set`;
          envBadge.className = "env-status-badge partial";
        }
      }
    } catch (err) {
      showToast(`Failed to load secrets: ${err.message}`, "error");
    }
  }

  if (btnSaveEnv) {
    btnSaveEnv.addEventListener("click", async () => {
      btnSaveEnv.disabled = true;
      btnSaveEnv.textContent = "⏳ Saving…";

      const payload = {};
      Object.entries(ENV_FIELD_MAP).forEach(([fieldId, envKey]) => {
        const input = document.getElementById(fieldId);
        if (input && input.value && !input.value.startsWith("****")) {
          payload[envKey] = input.value.trim();
        }
      });

      try {
        const resp = await fetch("/api/env", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ env: payload })
        });
        const data = await resp.json();
        if (data.success) {
          showToast("✅ Secrets saved and hot-reloaded", "success");
          loadEnvSecrets(); // Refresh masked display
        } else {
          showToast(`Save failed: ${data.error}`, "error");
        }
      } catch (err) {
        showToast(`Save error: ${err.message}`, "error");
      } finally {
        btnSaveEnv.disabled = false;
        btnSaveEnv.textContent = "💾 Save Secrets";
      }
    });
  }

  if (btnReloadEnv) {
    btnReloadEnv.addEventListener("click", () => {
      loadEnvSecrets();
      showToast("Secrets refreshed from server", "info");
    });
  }

});
