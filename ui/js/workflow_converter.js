/**
 * Tab 2: Workflow Converter & Explainer Controller
 */

class WorkflowConverterUI {
  constructor(canvas) {
    this.canvas = canvas;
    this.currentCleanedWorkflow = null;
    this._init();
  }

  _init() {
    const btnAnalyze = document.getElementById("btn-analyze-wf");
    const btnLoadCanvas = document.getElementById("btn-load-cleaned-canvas");
    const btnExportScript = document.getElementById("btn-export-python-script");

    if (btnAnalyze) {
      btnAnalyze.addEventListener("click", () => this.analyzeWorkflow());
    }
    if (btnLoadCanvas) {
      btnLoadCanvas.addEventListener("click", () => this.loadToCanvas());
    }
    if (btnExportScript) {
      btnExportScript.addEventListener("click", () => this.exportScript());
    }
  }

  async analyzeWorkflow() {
    const jsonInput = document.getElementById("wf-json-input").value.trim();
    const resultsBox = document.getElementById("wf-audit-results");
    const actionButtons = document.getElementById("wf-action-buttons");
    const scriptBox = document.getElementById("python-export-wrapper");

    if (!jsonInput) {
      alert("Please paste a workflow JSON first.");
      return;
    }

    try {
      resultsBox.innerHTML = "<p>Analyzing graph topology and node compatibility...</p>";
      
      // If valid JSON, send as object. If malformed, send raw text to trigger server-side JsonRepairSerializer
      let payloadJson;
      try {
        payloadJson = JSON.parse(jsonInput);
      } catch (clientErr) {
        // Malformed JSON (trailing comma, <think> tags, NaN) -> send as raw string for JsonRepairSerializer
        payloadJson = jsonInput;
      }

      const response = await fetch("/api/convert-workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow_json: payloadJson })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({ detail: "Conversion failed" }));
        throw new Error(errData.detail || "Server error");
      }

      const data = await response.json();
      this.currentCleanedWorkflow = data.cleaned_graph;

      // Render audit HTML
      let html = `
        <div class="audit-item">
          <strong>📊 De-cluttering Stats:</strong><br>
          Reduced from <b>${data.original_node_count}</b> nodes down to <b>${data.cleaned_node_count}</b> executable steps.<br>
          <span class="tag tag-success">🧹 Pruned ${data.pruned_clutter_count} Reroute / Note nodes</span>
        </div>
        <div class="audit-item">
          <strong>📖 Pipeline Explanation:</strong>
          <p style="margin-top: 4px; color: #cbd5e1;">${data.explanation}</p>
        </div>
        <div class="audit-item">
          <strong>⚙️ Node Compatibility:</strong><br>
      `;

      for (const s of data.supported_nodes) {
        html += `<span class="tag tag-success">✅ ${s.class_type} (${s.adapter})</span> `;
      }
      for (const m of data.missing_nodes) {
        html += `<span class="tag tag-warning">⚠️ ${m.class_type}</span> `;
      }
      html += `</div>`;

      resultsBox.innerHTML = html;
      actionButtons.style.display = "flex";
      scriptBox.style.display = "none";

    } catch (err) {
      resultsBox.innerHTML = `<p style="color: #ef4444;">Error: ${err.message}</p>`;
      actionButtons.style.display = "none";
    }
  }

  loadToCanvas() {
    if (!this.currentCleanedWorkflow) return;
    this.canvas.loadWorkflowJSON(this.currentCleanedWorkflow);
    // Switch to canvas tab
    document.querySelector('[data-tab="tab-canvas"]').click();
  }

  async exportScript() {
    const jsonInput = document.getElementById("wf-json-input").value.trim();
    const scriptBox = document.getElementById("python-export-wrapper");
    const scriptArea = document.getElementById("python-script-text");

    try {
      const response = await fetch("/api/export-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow_json: JSON.parse(jsonInput) })
      });

      const data = await response.json();
      scriptArea.value = data.python_script;
      scriptBox.style.display = "block";
    } catch (err) {
      alert(`Export failed: ${err.message}`);
    }
  }
}

window.WorkflowConverterUI = WorkflowConverterUI;
