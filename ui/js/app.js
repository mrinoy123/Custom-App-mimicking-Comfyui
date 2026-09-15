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
  btnLoadPreset.click();
});

