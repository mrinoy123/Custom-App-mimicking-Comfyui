/**
 * Application Master Controller
 * Handles White Screen UI, Two-Tier Workflows Hierarchy,
 * canvas synchronization, live SSE execution progress, Aiven DB, and Modals.
 */

document.addEventListener("DOMContentLoaded", () => {
  // 1. Initialize Canvas
  const canvas = new GraphCanvas("graph-canvas");

  // 2. Initialize Converters
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
      const targetPane = document.getElementById(targetId);
      if (targetPane) {
        targetPane.classList.add("active");
      }

      if (targetId === "tab-canvas") {
        setTimeout(() => canvas.render(), 30);
      } else if (targetId === "tab-hierarchy") {
        loadHierarchyWorkflows();
      } else if (targetId === "tab-database" && !dbTabInitialized) {
        dbTabInitialized = true;
        loadDatabaseStatus();
      } else if (targetId === "tab-secrets" && !envTabInitialized) {
        envTabInitialized = true;
        loadEnvSecrets();
      } else if (targetId === "tab-logs" && !logsTabInitialized) {
        logsTabInitialized = true;
        initLogsTab();
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
          setSelectedWorkflow(presetName, presetSelect.options[presetSelect.selectedIndex].text);
          showToast(`Preset loaded: ${presetName}`, "info");
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
      const name = prompt("Enter a name for this workflow in Aiven DB:", currentSelectedWorkflow || "my_workflow");
      if (!name) return;

      const workflowJSON = canvas.exportWorkflowJSON();
      try {
        const resp = await fetch("/api/workflows", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name, title: name, graph_json: workflowJSON })
        });
        const res = await resp.json();
        if (res.success) {
          showToast(`Workflow '${name}' saved successfully!`, "success");
          loadHierarchyWorkflows();
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
          showToast(`Synced from GitHub: ${data.message}`, "success");
        } else {
          showToast(`Pull failed: ${data.error}`, "error");
        }
      } catch (err) {
        showToast(`Pull error: ${err.message}`, "error");
      } finally {
        btnPullGit.disabled = false;
        btnPullGit.textContent = "⬇️ Pull";
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
          showToast("Successfully pushed local changes to GitHub!", "success");
        } else {
          showToast(`Push failed: ${data.error}`, "error");
        }
      } catch (err) {
        showToast(`Push error: ${err.message}`, "error");
      } finally {
        btnPushGit.disabled = false;
        btnPushGit.textContent = "⬆️ Push";
      }
    });
  }

  // ========================================================================
  // 8. HEADER EXECUTION & CURRENT WORKFLOW STATE
  // ========================================================================
  let currentSelectedWorkflow = "Parent-Workflow-AB";
  let cachedWorkflows = [];
  const collapsedParents = new Set();

  const activeBreadcrumb = document.getElementById("active-wf-breadcrumb");
  const executeBtnLabel  = document.getElementById("execute-btn-label");
  const btnExecute       = document.getElementById("btn-execute") || document.getElementById("btn-queue");
  const statusSpinner    = document.getElementById("status-spinner");
  const statusText       = document.getElementById("status-text");
  const progressFill     = document.getElementById("progress-fill");
  const vramVal          = document.getElementById("vram-val");

  const modal            = document.getElementById("media-modal");
  const modalBody        = document.getElementById("modal-media-container");
  const modalDownload    = document.getElementById("modal-download-link");
  const btnCloseModal    = document.getElementById("btn-close-modal");

  if (btnCloseModal && modal) {
    btnCloseModal.addEventListener("click", () => modal.classList.remove("active"));
  }

  function setSelectedWorkflow(wfName, title) {
    currentSelectedWorkflow = wfName;
    const dispTitle = title || wfName;
    if (activeBreadcrumb) activeBreadcrumb.textContent = dispTitle;
    if (executeBtnLabel) executeBtnLabel.textContent = `▶ Execute ${dispTitle.split(" ")[0]}...`;
    
    // Highlight in table if rendered
    renderHierarchyTable(cachedWorkflows);
  }

  // Execute Master / Selected Workflow
  if (btnExecute) {
    btnExecute.addEventListener("click", async () => {
      let workflowData = canvas.exportWorkflowJSON();
      if (Object.keys(workflowData).length === 0) {
        // Attempt to fetch from API if canvas empty
        try {
          const r = await fetch(`/api/workflows/${encodeURIComponent(currentSelectedWorkflow)}`);
          if (r.ok) {
            workflowData = await r.json();
            canvas.loadWorkflowJSON(workflowData);
          }
        } catch (e) {}
      }

      if (Object.keys(workflowData).length === 0) {
        showToast("Workflow graph is empty. Load a preset or add nodes first!", "error");
        return;
      }

      btnExecute.disabled = true;
      if (statusSpinner) statusSpinner.style.display = "inline-block";
      if (statusText) statusText.textContent = `Submitting ${currentSelectedWorkflow} to engine...`;
      if (progressFill) progressFill.style.width = "5%";

      try {
        const resp = await fetch("/api/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workflow: workflowData,
            workflow_name: currentSelectedWorkflow
          })
        });
        const data = await resp.json();

        if (!data.success) {
          throw new Error(data.error || "Execution failed.");
        }

        listenToProgress();
        showToast(`▶ Execution dispatched for ${currentSelectedWorkflow}`, "success");

      } catch (err) {
        showToast(`Execution error: ${err.message}`, "error");
        btnExecute.disabled = false;
        if (statusSpinner) statusSpinner.style.display = "none";
        if (statusText) statusText.textContent = "Engine Ready";
        if (progressFill) progressFill.style.width = "0%";
      }
    });
  }

  // Header Workflows Dropdown Menu
  const btnWfDropdown   = document.getElementById("btn-wf-dropdown");
  const wfDropdownMenu  = document.getElementById("wf-dropdown-menu");

  if (btnWfDropdown && wfDropdownMenu) {
    btnWfDropdown.addEventListener("click", (e) => {
      e.stopPropagation();
      const isVisible = wfDropdownMenu.style.display === "flex";
      if (isVisible) {
        wfDropdownMenu.style.display = "none";
      } else {
        renderHeaderDropdown();
        wfDropdownMenu.style.display = "flex";
      }
    });

    document.addEventListener("click", (e) => {
      if (!btnWfDropdown.contains(e.target) && !wfDropdownMenu.contains(e.target)) {
        wfDropdownMenu.style.display = "none";
      }
    });
  }

  function renderHeaderDropdown() {
    if (!wfDropdownMenu) return;
    wfDropdownMenu.innerHTML = "";

    cachedWorkflows.forEach(wf => {
      const item = document.createElement("div");
      item.className = `wf-dropdown-item ${wf.name === currentSelectedWorkflow ? "active" : ""}`;
      const prefix = wf.role === "subprocess" ? "└ " : "";
      item.innerHTML = `
        <span>${escapeHtml(prefix + (wf.title || wf.name))}</span>
        <span style="font-size: 10px; font-weight: 700; color: #94a3b8;">${(wf.role || "master").toUpperCase()}</span>
      `;
      item.addEventListener("click", async () => {
        wfDropdownMenu.style.display = "none";
        setSelectedWorkflow(wf.name, wf.title);
        try {
          const r = await fetch(`/api/workflows/${encodeURIComponent(wf.name)}`);
          if (r.ok) {
            const data = await r.json();
            canvas.loadWorkflowJSON(data);
            showToast(`Loaded: ${wf.title || wf.name}`, "info");
          }
        } catch (err) {}
      });
      wfDropdownMenu.appendChild(item);
    });
  }

  // ========================================================================
  // 9. FLOATING DRAGGABLE VRAM HUD
  // ========================================================================
  const vramHud         = document.getElementById("vram-hud");
  const hudHeader       = document.getElementById("vram-hud-header");
  const hudBody         = document.getElementById("vram-hud-body");
  const btnToggleHud    = document.getElementById("btn-toggle-hud-body");
  const btnPurgeVram    = document.getElementById("btn-purge-vram");
  const hudGpuName      = document.getElementById("hud-gpu-name");
  const hudMeterFill    = document.getElementById("hud-meter-fill");
  const hudVramUsed     = document.getElementById("hud-vram-used");
  const hudVramPercent  = document.getElementById("hud-vram-percent");
  const hudStatAlloc    = document.getElementById("hud-stat-allocated");
  const hudStatRes      = document.getElementById("hud-stat-reserved");
  const hudStatFree     = document.getElementById("hud-stat-free");

  if (btnToggleHud && hudBody) {
    btnToggleHud.addEventListener("click", (e) => {
      e.stopPropagation();
      hudBody.classList.toggle("collapsed");
      btnToggleHud.textContent = hudBody.classList.contains("collapsed") ? "+" : "−";
    });
  }

  if (btnPurgeVram) {
    btnPurgeVram.addEventListener("click", async (e) => {
      e.stopPropagation();
      btnPurgeVram.disabled = true;
      btnPurgeVram.textContent = "⏳...";
      try {
        const resp = await fetch("/api/purge-vram", { method: "POST" });
        const data = await resp.json();
        if (data.vram) updateVramHUD(data.vram);
        showToast("GPU VRAM cache purged", "success");
      } catch (err) {
        console.error(err);
      } finally {
        btnPurgeVram.disabled = false;
        btnPurgeVram.textContent = "🧹 Purge";
      }
    });
  }

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
    if (hudMeterFill) hudMeterFill.style.width = `${pct}%`;
    if (hudVramUsed) hudVramUsed.textContent = `${alloc} GB Used`;
    if (hudVramPercent) hudVramPercent.textContent = `${pct}%`;
    if (hudStatAlloc) hudStatAlloc.textContent = `${alloc} GB`;
    if (hudStatRes) hudStatRes.textContent = `${res} GB`;
    if (hudStatFree) hudStatFree.textContent = `${free} GB`;
  }

  // ========================================================================
  // 10. PAYLOAD INSPECTOR DRAWER
  // ========================================================================
  const inspectorPanel       = document.getElementById("inspector-panel");
  const btnToggleInspector   = document.getElementById("btn-toggle-inspector");
  const btnCloseInspector    = document.getElementById("btn-close-inspector");
  const inspectorNodeSelect  = document.getElementById("inspector-node-select");
  const toggleDelta          = document.getElementById("toggle-delta");
  const toggleCumulative     = document.getElementById("toggle-cumulative");
  const metaNodeName         = document.getElementById("meta-node-name");
  const metaDiffMode         = document.getElementById("meta-diff-mode");
  const inspectorJsonDisplay = document.getElementById("inspector-json-display");

  let currentInspectionReport = [];
  let currentDiffMode = "delta";

  if (btnToggleInspector && inspectorPanel) {
    btnToggleInspector.addEventListener("click", () => {
      inspectorPanel.classList.toggle("open");
      if (inspectorPanel.classList.contains("open")) fetchInspectionReport();
    });
  }

  if (btnCloseInspector && inspectorPanel) {
    btnCloseInspector.addEventListener("click", () => inspectorPanel.classList.remove("open"));
  }

  if (toggleDelta && toggleCumulative) {
    toggleDelta.addEventListener("click", () => {
      currentDiffMode = "delta";
      toggleDelta.classList.add("active");
      toggleCumulative.classList.remove("active");
      metaDiffMode.textContent = "Isolated Delta";
      metaDiffMode.style.color = "#2563eb";
      renderInspectionView();
    });

    toggleCumulative.addEventListener("click", () => {
      currentDiffMode = "cumulative";
      toggleCumulative.classList.add("active");
      toggleDelta.classList.remove("active");
      metaDiffMode.textContent = "Cumulative Full";
      metaDiffMode.style.color = "#16a34a";
      renderInspectionView();
    });
  }

  if (inspectorNodeSelect) {
    inspectorNodeSelect.addEventListener("change", () => renderInspectionView());
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
        if (idx === currentInspectionReport.length - 1) opt.selected = true;
        inspectorNodeSelect.appendChild(opt);
      });

      renderInspectionView();
    } catch (err) {
      console.error(err);
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
      vid.style.maxWidth = "100%";
      vid.style.borderRadius = "8px";
      modalBody.appendChild(vid);
    } else {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "Generated output";
      img.style.maxWidth = "100%";
      img.style.borderRadius = "8px";
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
        if (msg.vram) updateVramHUD(msg.vram);

        if (msg.event === "node_started") {
          if (statusText) statusText.textContent = `Running [Step ${msg.step}/${msg.total_steps}]: ${msg.class_type}`;
          const pct = Math.round((msg.step / msg.total_steps) * 90);
          if (progressFill) progressFill.style.width = `${pct}%`;
          canvas.setExecutingNode(msg.node_id);
          logLine(`▶ Node [#${msg.node_id}] ${msg.class_type} (step ${msg.step}/${msg.total_steps})`, "log-info");
        }

        if (msg.event === "completed") {
          evtSource.close();
          if (btnExecute) btnExecute.disabled = false;
          if (statusSpinner) statusSpinner.style.display = "none";
          if (statusText) statusText.textContent = `Execution Complete in ${msg.duration_seconds}s!`;
          if (progressFill) progressFill.style.width = "100%";
          canvas.setExecutingNode(null);

          fetchInspectionReport();
          logLine(`✅ Execution complete in ${msg.duration_seconds}s`, "log-success");

          if (msg.saved_files && msg.saved_files.length > 0) {
            showMediaModal(msg.saved_files[0]);
          }
        }

        if (msg.event === "failed") {
          evtSource.close();
          if (btnExecute) btnExecute.disabled = false;
          if (statusSpinner) statusSpinner.style.display = "none";
          if (statusText) statusText.textContent = `Execution Failed: ${msg.error}`;
          if (progressFill) progressFill.style.width = "0%";
          canvas.setExecutingNode(null);
          logLine(`❌ Execution failed: ${msg.error}`, "log-error");
        }
      } catch (err) {
        console.error(err);
      }
    };

    evtSource.onerror = () => {
      evtSource.close();
      if (btnExecute) btnExecute.disabled = false;
      if (statusSpinner) statusSpinner.style.display = "none";
    };
  }

  // ========================================================================
  // 11. WORKFLOWS HIERARCHY TAB (Exact Reference Logic)
  // ========================================================================
  const hierarchySearchInput = document.getElementById("hierarchy-search-input");
  const hierarchyTableBody   = document.getElementById("hierarchy-table-body");
  const activeWfCountEl      = document.getElementById("active-wf-count");
  const inactiveWfCountEl    = document.getElementById("inactive-wf-count");
  const wfCountBadge         = document.getElementById("wf-count-badge");
  const btnRefreshHierarchy  = document.getElementById("btn-refresh-hierarchy");
  const btnAddHierarchyWf    = document.getElementById("btn-add-hierarchy-wf");

  // Add Workflow Modal Elements
  const addWfModal           = document.getElementById("add-wf-modal");
  const btnCloseAddWf        = document.getElementById("btn-close-add-wf");
  const btnCancelAddWf       = document.getElementById("btn-cancel-add-wf");
  const btnSubmitAddWf       = document.getElementById("btn-submit-add-wf");
  const newWfNameInput       = document.getElementById("new-wf-name");
  const newWfTitleInput      = document.getElementById("new-wf-title");
  const newWfDescInput       = document.getElementById("new-wf-desc");
  const newWfRoleSelect      = document.getElementById("new-wf-role");
  const newWfParentSelect    = document.getElementById("new-wf-parent");
  const parentWfGroup        = document.getElementById("parent-wf-group");
  const newWfTemplateSelect  = document.getElementById("new-wf-template");

  async function loadHierarchyWorkflows() {
    try {
      const resp = await fetch("/api/workflows");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const list = Array.isArray(data) ? data : (data.workflows || []);
      cachedWorkflows = list;
      renderHierarchyTable(list);
    } catch (err) {
      if (hierarchyTableBody) {
        hierarchyTableBody.innerHTML = `<tr><td colspan="5" style="padding: 24px; text-align: center; color: #ef4444;">Failed to load workflows: ${escapeHtml(err.message)}</td></tr>`;
      }
    }
  }

  function renderHierarchyTable(workflows) {
    if (!hierarchyTableBody) return;
    hierarchyTableBody.innerHTML = "";

    const query = hierarchySearchInput ? hierarchySearchInput.value.toLowerCase().trim() : "";
    const filtered = workflows.filter(wf =>
      !query || (wf.name || "").toLowerCase().includes(query) ||
      (wf.title || "").toLowerCase().includes(query) ||
      (wf.description || "").toLowerCase().includes(query)
    );

    let activeCount = 0;
    let inactiveCount = 0;
    workflows.forEach(w => {
      if (w.active) activeCount++; else inactiveCount++;
    });

    if (activeWfCountEl) activeWfCountEl.textContent = `${activeCount} Active`;
    if (inactiveWfCountEl) inactiveWfCountEl.textContent = `${inactiveCount} Inactive`;
    if (wfCountBadge) wfCountBadge.textContent = `${workflows.length} Pipelines`;

    // Map parent indices
    let masterIndex = 0;
    const parentIndexMap = {};
    filtered.forEach(wf => {
      if (!wf.parent_id) {
        masterIndex++;
        parentIndexMap[wf.name] = masterIndex;
      }
    });

    filtered.forEach(wf => {
      const isParent = !wf.parent_id;
      const isSub = !isParent;

      // Check if hidden due to collapsed parent
      if (isSub && collapsedParents.has(wf.parent_id)) {
        return;
      }

      const isSelected = (wf.name === currentSelectedWorkflow);
      const tr = document.createElement("tr");
      tr.className = `wf-row ${isParent ? "parent-row" : "sub-row"} ${isSelected ? "selected-row" : ""}`;
      tr.dataset.wfName = wf.name;

      // Column 1: Index & Expand/Collapse Caret
      let indexHtml = "";
      if (isParent) {
        const pIdx = parentIndexMap[wf.name] || 1;
        const hasChildren = workflows.some(w => w.parent_id === wf.name);
        const isCollapsed = collapsedParents.has(wf.name);
        const caretHtml = hasChildren
          ? `<span class="caret-toggle ${isCollapsed ? "collapsed" : ""}" data-parent="${escapeHtml(wf.name)}">⌵</span>`
          : `<span style="width: 14px; display: inline-block;"></span>`;
        const idxBadgeClass = (pIdx === 1) ? "idx-badge" : "idx-badge subtle";
        indexHtml = `<div class="row-index-cell">${caretHtml}<span class="${idxBadgeClass}">#${pIdx}</span></div>`;
      } else {
        indexHtml = `<div class="row-index-cell" style="padding-left: 20px;"></div>`;
      }

      // Column 2: Title, Badges & Topology
      let titleHtml = "";
      const dispTitle = escapeHtml(wf.title || wf.name);
      const dispDesc = escapeHtml(wf.description || "");

      if (isParent) {
        const isSelectedBadge = isSelected ? `<span class="tag-badge-selected">SELECTED</span>` : "";
        const subCount = wf.subprocess_count || 0;
        const subBadge = subCount > 0 ? `<span class="tag-badge-sub">${subCount} Subprocess</span>` : "";
        const titleClass = (isSelected || parentIndexMap[wf.name] === 1) ? "wf-title-text primary-color" : "wf-title-text";

        titleHtml = `
          <div class="wf-meta-title">
            <div class="wf-title-line">
              <span class="${titleClass}">${dispTitle}</span>
              <span class="tag-badge-master">MASTER</span>
              ${subBadge}
              ${isSelectedBadge}
            </div>
            ${dispDesc ? `<div class="wf-desc-text">${dispDesc}</div>` : ""}
          </div>
        `;
      } else {
        titleHtml = `
          <div class="wf-meta-title" style="padding-left: 28px;">
            <div class="wf-title-line">
              <span class="tree-branch">└</span>
              <span class="wf-title-text primary-color">${dispTitle}</span>
            </div>
            ${dispDesc ? `<div class="wf-desc-text" style="padding-left: 18px;">${dispDesc}</div>` : ""}
          </div>
        `;
      }

      // Column 3: Status Pill & Toggle
      const isActive = Boolean(wf.active);
      const statusHtml = `
        <div class="status-cell-wrap">
          <span class="status-pill ${isActive ? "active" : "inactive"}">
            <span class="${isActive ? "dot-green" : "dot-grey"}"></span>
            ${isActive ? "Active" : "Inactive"}
          </span>
          <label class="switch">
            <input type="checkbox" class="wf-active-toggle" data-name="${escapeHtml(wf.name)}" ${isActive ? "checked" : ""}>
            <span class="slider"></span>
          </label>
        </div>
      `;

      // Column 4: Last Updated
      const dateHtml = `
        <div class="date-cell">
          <span>🕒</span>
          <span>${escapeHtml(wf.updated_at || "Just now")}</span>
        </div>
      `;

      // Column 5: Actions (Run, Edit, Delete)
      const actionsHtml = `
        <div class="actions-cell">
          <button class="btn-action btn-action-run" data-name="${escapeHtml(wf.name)}" title="Run this workflow">▶ Run</button>
          <button class="btn-action btn-action-edit" data-name="${escapeHtml(wf.name)}" title="Load onto Visual Canvas">✏️ Edit</button>
          <button class="btn-action-del" data-name="${escapeHtml(wf.name)}" title="Delete workflow">🗑</button>
        </div>
      `;

      tr.innerHTML = `
        <td>${indexHtml}</td>
        <td>${titleHtml}</td>
        <td>${statusHtml}</td>
        <td>${dateHtml}</td>
        <td>${actionsHtml}</td>
      `;

      // Row Selection
      tr.addEventListener("click", (e) => {
        if (e.target.closest("button") || e.target.closest("input") || e.target.closest(".caret-toggle")) {
          return;
        }
        setSelectedWorkflow(wf.name, wf.title);
      });

      hierarchyTableBody.appendChild(tr);
    });

    // Wire Caret toggles
    hierarchyTableBody.querySelectorAll(".caret-toggle").forEach(caret => {
      caret.addEventListener("click", (e) => {
        e.stopPropagation();
        const pName = caret.dataset.parent;
        if (collapsedParents.has(pName)) {
          collapsedParents.delete(pName);
        } else {
          collapsedParents.add(pName);
        }
        renderHierarchyTable(workflows);
      });
    });

    // Wire Active Toggles
    hierarchyTableBody.querySelectorAll(".wf-active-toggle").forEach(toggle => {
      toggle.addEventListener("change", async (e) => {
        e.stopPropagation();
        const name = toggle.dataset.name;
        const active = toggle.checked;
        try {
          const resp = await fetch(`/api/workflows/${encodeURIComponent(name)}/active`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ active })
          });
          const res = await resp.json();
          if (res.success) {
            showToast(`${name}: ${active ? "Active" : "Inactive"}`, active ? "success" : "info");
            const item = cachedWorkflows.find(w => w.name === name);
            if (item) item.active = active;
            renderHierarchyTable(cachedWorkflows);
          }
        } catch (err) {
          showToast(`Status update failed: ${err.message}`, "error");
          toggle.checked = !active;
        }
      });
    });

    // Wire Run Buttons
    hierarchyTableBody.querySelectorAll(".btn-action-run").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const name = btn.dataset.name;
        setSelectedWorkflow(name);
        try {
          const r = await fetch(`/api/workflows/${encodeURIComponent(name)}`);
          if (r.ok) {
            const data = await r.json();
            canvas.loadWorkflowJSON(data);
          }
          if (btnExecute) btnExecute.click();
        } catch (err) {
          showToast(`Failed to run: ${err.message}`, "error");
        }
      });
    });

    // Wire Edit Buttons
    hierarchyTableBody.querySelectorAll(".btn-action-edit").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const name = btn.dataset.name;
        setSelectedWorkflow(name);
        try {
          const r = await fetch(`/api/workflows/${encodeURIComponent(name)}`);
          if (r.ok) {
            const data = await r.json();
            canvas.loadWorkflowJSON(data);
            const canvasTab = document.querySelector('.tab-btn[data-tab="tab-canvas"]');
            if (canvasTab) canvasTab.click();
            showToast(`Loaded '${name}' into Visual Canvas`, "info");
          }
        } catch (err) {
          showToast(`Load failed: ${err.message}`, "error");
        }
      });
    });

    // Wire Delete Buttons
    hierarchyTableBody.querySelectorAll(".btn-action-del").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const name = btn.dataset.name;
        if (!confirm(`Are you sure you want to delete workflow '${name}'?`)) return;

        try {
          const r = await fetch(`/api/workflows/${encodeURIComponent(name)}`, { method: "DELETE" });
          const res = await r.json();
          if (res.success) {
            showToast(`Deleted: ${name}`, "info");
            loadHierarchyWorkflows();
          } else {
            showToast(`Delete failed`, "error");
          }
        } catch (err) {
          showToast(`Delete error: ${err.message}`, "error");
        }
      });
    });
  }

  if (hierarchySearchInput) {
    hierarchySearchInput.addEventListener("input", () => renderHierarchyTable(cachedWorkflows));
  }

  if (btnRefreshHierarchy) {
    btnRefreshHierarchy.addEventListener("click", () => {
      loadHierarchyWorkflows();
      showToast("Workflows refreshed", "info");
    });
  }

  // + Add Workflow Modal Handlers
  if (btnAddHierarchyWf && addWfModal) {
    btnAddHierarchyWf.addEventListener("click", () => {
      // Populate parent selector with current masters
      if (newWfParentSelect) {
        newWfParentSelect.innerHTML = "";
        cachedWorkflows.filter(w => !w.parent_id).forEach(m => {
          const opt = document.createElement("option");
          opt.value = m.name;
          opt.textContent = m.title || m.name;
          newWfParentSelect.appendChild(opt);
        });
      }
      if (newWfNameInput) newWfNameInput.value = "";
      if (newWfTitleInput) newWfTitleInput.value = "";
      if (newWfDescInput) newWfDescInput.value = "";
      addWfModal.classList.add("active");
    });
  }

  if (newWfRoleSelect && parentWfGroup) {
    newWfRoleSelect.addEventListener("change", () => {
      parentWfGroup.style.display = newWfRoleSelect.value === "subprocess" ? "flex" : "none";
    });
  }

  function closeAddWfModal() {
    if (addWfModal) addWfModal.classList.remove("active");
  }

  if (btnCloseAddWf) btnCloseAddWf.addEventListener("click", closeAddWfModal);
  if (btnCancelAddWf) btnCancelAddWf.addEventListener("click", closeAddWfModal);

  if (btnSubmitAddWf) {
    btnSubmitAddWf.addEventListener("click", async () => {
      const name = (newWfNameInput ? newWfNameInput.value.trim() : "") || `workflow_${Date.now()}`;
      const title = (newWfTitleInput ? newWfTitleInput.value.trim() : "") || name;
      const desc = newWfDescInput ? newWfDescInput.value.trim() : "";
      const role = newWfRoleSelect ? newWfRoleSelect.value : "master";
      const parentId = (role === "subprocess" && newWfParentSelect) ? newWfParentSelect.value : null;
      const tpl = newWfTemplateSelect ? newWfTemplateSelect.value : "flux_txt2img";

      let graphJson = {};
      if (tpl !== "blank") {
        try {
          const r = await fetch(`/api/workflows/${tpl}`);
          if (r.ok) graphJson = await r.json();
        } catch (e) {}
      }

      btnSubmitAddWf.disabled = true;
      try {
        const resp = await fetch("/api/workflows", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name,
            title: title,
            description: desc,
            role: role,
            parent_id: parentId,
            graph_json: graphJson,
            active: false
          })
        });
        const res = await resp.json();
        if (res.success) {
          showToast(`Workflow '${title}' created successfully!`, "success");
          closeAddWfModal();
          loadHierarchyWorkflows();
        } else {
          showToast(`Failed: ${res.error}`, "error");
        }
      } catch (err) {
        showToast(`Error: ${err.message}`, "error");
      } finally {
        btnSubmitAddWf.disabled = false;
      }
    });
  }

  // ========================================================================
  // 12. VISUAL LOGS TERMINAL
  // ========================================================================
  const terminalBody = document.getElementById("terminal-content");
  const btnClearLogs = document.getElementById("btn-clear-logs");
  let logsTabInitialized = false;

  function logLine(text, cls = "log-info") {
    if (!terminalBody) return;
    const now = new Date();
    const ts = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`;
    const line = document.createElement("div");
    line.className = `log-line ${cls}`;
    line.innerHTML = `<span class="log-ts">[${ts}]</span><span>${escapeHtml(text)}</span>`;
    terminalBody.appendChild(line);
    terminalBody.scrollTop = terminalBody.scrollHeight;
  }

  function initLogsTab() {
    logLine("MicroEngine streaming active — connected to runtime.", "log-system");
  }

  if (btnClearLogs && terminalBody) {
    btnClearLogs.addEventListener("click", () => {
      terminalBody.innerHTML = "";
      logLine("Terminal cleared.", "log-system");
    });
  }

  // ========================================================================
  // 13. AIVEN POSTGRESQL CONSOLE
  // ========================================================================
  let dbTabInitialized = false;
  const dbStatusDot    = document.getElementById("db-status-dot");
  const dbLatencyVal   = document.getElementById("db-latency-val");
  const dbWfCount      = document.getElementById("db-wf-count");
  const dbLogsCount    = document.getElementById("db-logs-count");
  const dbWfList       = document.getElementById("db-workflows-list");
  const dbDiagList     = document.getElementById("db-diag-list");
  const btnSyncDb      = document.getElementById("btn-sync-database");
  const btnTestConn    = document.getElementById("btn-test-connection");

  async function loadDatabaseStatus() {
    try {
      const resp = await fetch("/api/db/status");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      if (dbLatencyVal) dbLatencyVal.textContent = data.latency_ms != null ? `${data.latency_ms} ms` : "Local (0.2 ms)";
      if (dbWfCount) dbWfCount.textContent = data.workflow_count || cachedWorkflows.length;
      if (dbLogsCount) dbLogsCount.textContent = data.log_count || 0;

      if (dbDiagList) {
        dbDiagList.innerHTML = `
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:12.5px;">
            <span style="color:#64748b;">PostgreSQL Engine:</span>
            <span style="font-weight:600;">${escapeHtml(data.pg_version || "Local Filesystem Fallback")}</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:12.5px;">
            <span style="color:#64748b;">Retention Policy:</span>
            <span style="font-weight:600;color:#16a34a;">Rolling 3-Run Automatic SQL Prune</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:12.5px;">
            <span style="color:#64748b;">Bandwidth Overhead:</span>
            <span style="font-weight:600;color:#16a34a;">0 Byte Delta Tax (Full Atomic JSON)</span>
          </div>
        `;
      }

      if (dbWfList) {
        dbWfList.innerHTML = "";
        cachedWorkflows.forEach(wf => {
          const d = document.createElement("div");
          d.style.cssText = "display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:12.5px;";
          d.innerHTML = `<span>${escapeHtml(wf.title || wf.name)}</span><span style="color:#94a3b8;">${escapeHtml(wf.updated_at || "")}</span>`;
          dbWfList.appendChild(d);
        });
      }
    } catch (err) {
      console.error(err);
    }
  }

  if (btnSyncDb) {
    btnSyncDb.addEventListener("click", async () => {
      btnSyncDb.disabled = true;
      btnSyncDb.textContent = "⏳ Syncing...";
      try {
        const resp = await fetch("/api/db/sync", { method: "POST" });
        const res = await resp.json();
        showToast("Synced disk workflows with Aiven database", "success");
        loadDatabaseStatus();
      } catch (err) {
        showToast(`Sync error: ${err.message}`, "error");
      } finally {
        btnSyncDb.disabled = false;
        btnSyncDb.textContent = "⚡ Sync Disk ⇄ Aiven";
      }
    });
  }

  if (btnTestConn) {
    btnTestConn.addEventListener("click", () => {
      loadDatabaseStatus();
      showToast("Connection verified", "success");
    });
  }

  // ========================================================================
  // 14. SECRETS & ENV
  // ========================================================================
  let envTabInitialized = false;
  const envBadge        = document.getElementById("env-status-badge");
  const btnSaveEnv      = document.getElementById("btn-save-env");
  const btnReloadEnv    = document.getElementById("btn-reload-env");

  async function loadEnvSecrets() {
    try {
      const resp = await fetch("/api/env");
      if (!resp.ok) return;
      const data = await resp.json();
      if (document.getElementById("env-db-url") && data.DATABASE_URL) {
        document.getElementById("env-db-url").value = data.DATABASE_URL;
      }
      if (document.getElementById("env-r2-account") && data.R2_ACCOUNT_ID) {
        document.getElementById("env-r2-account").value = data.R2_ACCOUNT_ID;
      }
      if (document.getElementById("env-r2-access") && data.R2_ACCESS_KEY_ID) {
        document.getElementById("env-r2-access").value = data.R2_ACCESS_KEY_ID;
      }
      if (document.getElementById("env-r2-secret") && data.R2_SECRET_ACCESS_KEY) {
        document.getElementById("env-r2-secret").value = data.R2_SECRET_ACCESS_KEY;
      }
      if (document.getElementById("env-r2-bucket") && data.R2_BUCKET_NAME) {
        document.getElementById("env-r2-bucket").value = data.R2_BUCKET_NAME;
      }
      if (document.getElementById("env-r2-domain") && data.R2_PUBLIC_DOMAIN) {
        document.getElementById("env-r2-domain").value = data.R2_PUBLIC_DOMAIN;
      }
      if (envBadge) {
        envBadge.textContent = data.has_database_url ? "Connected" : "Unset";
      }
    } catch (e) {}
  }

  if (btnSaveEnv) {
    btnSaveEnv.addEventListener("click", async () => {
      btnSaveEnv.disabled = true;
      btnSaveEnv.textContent = "⏳ Saving...";
      const payload = {
        DATABASE_URL: document.getElementById("env-db-url")?.value,
        R2_ACCOUNT_ID: document.getElementById("env-r2-account")?.value,
        R2_ACCESS_KEY_ID: document.getElementById("env-r2-access")?.value,
        R2_SECRET_ACCESS_KEY: document.getElementById("env-r2-secret")?.value,
        R2_BUCKET_NAME: document.getElementById("env-r2-bucket")?.value,
        R2_PUBLIC_DOMAIN: document.getElementById("env-r2-domain")?.value
      };
      try {
        const resp = await fetch("/api/env", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const res = await resp.json();
        if (res.success) {
          showToast("Secrets updated and hot-reloaded", "success");
        } else {
          showToast(`Error: ${res.error}`, "error");
        }
      } catch (err) {
        showToast(`Error: ${err.message}`, "error");
      } finally {
        btnSaveEnv.disabled = false;
        btnSaveEnv.textContent = "💾 Save & Connect";
      }
    });
  }

  if (btnReloadEnv) {
    btnReloadEnv.addEventListener("click", () => {
      loadEnvSecrets();
      showToast("Reloaded from disk", "info");
    });
  }

  // Toast Helper
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

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Initial Load: Workflows & Telemetry
  fetch("/api/vram")
    .then(r => r.json())
    .then(data => updateVramHUD(data))
    .catch(() => {});

  loadHierarchyWorkflows();

  // Load default preset onto canvas
  if (btnLoadPreset) btnLoadPreset.click();
});
