/**
 * Tab 3: Node Ingestion & AST De-bloating Controller
 */

class NodeConverterUI {
  constructor(canvas) {
    this.canvas = canvas;
    this._init();
  }

  _init() {
    const btnScan = document.getElementById("btn-scan-nodes");
    const btnConvert = document.getElementById("btn-convert-node");
    const selectNode = document.getElementById("detected-nodes-select");

    if (btnScan) {
      btnScan.addEventListener("click", () => this.scanNodes());
    }
    if (selectNode) {
      selectNode.addEventListener("change", () => this.onNodeSelected());
    }
    if (btnConvert) {
      btnConvert.addEventListener("click", () => this.convertNode());
    }
  }

  async scanNodes() {
    const code = document.getElementById("node-code-input").value.trim();
    const select = document.getElementById("detected-nodes-select");
    const preview = document.getElementById("node-preview-box");
    const btnConvert = document.getElementById("btn-convert-node");

    if (!code) {
      alert("Please paste ComfyUI Python node code first.");
      return;
    }

    try {
      preview.innerHTML = "<p>Analyzing AST to detect node classes...</p>";

      const response = await fetch("/api/scan-nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ python_code: code })
      });

      const data = await response.json();
      if (!data.nodes || data.nodes.length === 0) {
        preview.innerHTML = "<p style='color: #f59e0b;'>No ComfyUI node classes detected in code.</p>";
        select.disabled = true;
        btnConvert.disabled = true;
        return;
      }

      select.innerHTML = '<option value="">-- Choose Node to Convert --</option>';
      for (const n of data.nodes) {
        select.innerHTML += `<option value="${n.class_name}">${n.class_name} (Line ${n.line_number})</option>`;
      }
      select.disabled = false;
      preview.innerHTML = `<p style="color: #10b981;">Found <b>${data.nodes.length}</b> node class(es). Select one from the dropdown above.</p>`;

    } catch (err) {
      preview.innerHTML = `<p style="color: #ef4444;">Scan failed: ${err.message}</p>`;
    }
  }

  onNodeSelected() {
    const select = document.getElementById("detected-nodes-select");
    const btnConvert = document.getElementById("btn-convert-node");
    const preview = document.getElementById("node-preview-box");
    const selectedClass = select.value;

    if (!selectedClass) {
      btnConvert.disabled = true;
      return;
    }

    btnConvert.disabled = false;
    preview.innerHTML = `
      <div class="audit-item">
        <strong>Target Class:</strong> <code>${selectedClass}</code><br>
        <span class="tag tag-success">Ready to extract pure PyTorch math</span>
      </div>
    `;
  }

  async convertNode() {
    const code = document.getElementById("node-code-input").value.trim();
    const select = document.getElementById("detected-nodes-select");
    const preview = document.getElementById("node-preview-box");
    const selectedClass = select.value;

    if (!selectedClass) return;

    try {
      preview.innerHTML = `<p>Extracting ${selectedClass}, removing bloat, and generating BaseAdapter...</p>`;

      const response = await fetch("/api/convert-node", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          python_code: code,
          selected_class_name: selectedClass
        })
      });

      const data = await response.json();
      if (data.success) {
        preview.innerHTML = `
          <div class="audit-item" style="color: #10b981;">
            🎉 <b>Success!</b> Converted <code>${data.class_name}</code> into <code>${data.adapter_class}</code>.<br>
            Saved to: <code>${data.output_path}</code><br>
            <span class="tag tag-success">Registered into palette</span>
          </div>
        `;

        // Add to palette dropdown on Tab 1
        const paletteSelect = document.getElementById("node-palette-select");
        if (paletteSelect) {
          const opt = document.createElement("option");
          opt.value = data.class_name;
          opt.textContent = `${data.class_name} (Custom Adapter)`;
          paletteSelect.appendChild(opt);
        }

        // Register in window definitions
        window.NODE_DEFINITIONS[data.class_name] = {
          title: data.class_name,
          color: "#059669",
          inputs: { input: "ANY" },
          outputs: { output: "ANY" },
          fields: {}
        };
      }
    } catch (err) {
      preview.innerHTML = `<p style="color: #ef4444;">Conversion failed: ${err.message}</p>`;
    }
  }
}

window.NodeConverterUI = NodeConverterUI;
