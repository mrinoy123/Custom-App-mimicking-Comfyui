/**
 * Interactive HTML5 Node Graph Canvas
 * Supports dragging, wire linking, zooming, panning, and JSON import/export.
 */

class GraphCanvas {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    
    this.nodes = [];
    this.connections = []; // { fromNode, fromPin, toNode, toPin }
    this.activeNodeId = null;
    this.executingNodeId = null;

    // Viewport transform
    this.panX = 40;
    this.panY = 40;
    this.zoom = 1.0;

    // Dragging state
    this.isDraggingNode = false;
    this.draggedNode = null;
    this.dragOffset = { x: 0, y: 0 };

    this.isConnecting = false;
    this.connectingFrom = null; // { node, pinName, isOutput, x, y }

    this.isPanning = false;
    this.panStart = { x: 0, y: 0 };

    this._setupResize();
    this._setupEvents();
    this.render();
  }

  _setupResize() {
    const resize = () => {
      const rect = this.canvas.parentElement.getBoundingClientRect();
      this.canvas.width = rect.width;
      this.canvas.height = rect.height;
      this.render();
    };
    window.addEventListener('resize', resize);
    setTimeout(resize, 50);
  }

  _setupEvents() {
    this.canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
    this.canvas.addEventListener('mouseup', (e) => this._onMouseUp(e));
    this.canvas.addEventListener('wheel', (e) => this._onWheel(e));
  }

  screenToWorld(sx, sy) {
    return {
      x: (sx - this.panX) / this.zoom,
      y: (sy - this.panY) / this.zoom
    };
  }

  worldToScreen(wx, wy) {
    return {
      x: wx * this.zoom + this.panX,
      y: wy * this.zoom + this.panY
    };
  }

  addNode(classType, wx = 100, wy = 100) {
    const def = window.NODE_DEFINITIONS[classType] || {
      title: classType,
      color: "#4f46e5",
      inputs: { input: "ANY" },
      outputs: { output: "ANY" },
      fields: {}
    };

    const node = {
      id: String(this.nodes.length + 1),
      classType: classType,
      title: def.title,
      color: def.color,
      x: wx,
      y: wy,
      width: 220,
      height: 120 + Object.keys(def.fields).length * 28,
      inputs: { ...def.inputs },
      outputs: { ...def.outputs },
      fields: { ...def.fields },
      values: {}
    };

    // Initialize field values
    for (const [k, f] of Object.entries(def.fields)) {
      node.values[k] = f.default;
    }

    this.nodes.push(node);
    this.render();
    return node;
  }

  clear() {
    this.nodes = [];
    this.connections = [];
    this.render();
  }

  getPinCoords(node, pinName, isOutput) {
    const headerH = 32;
    const spacing = 22;
    if (isOutput) {
      const keys = Object.keys(node.outputs);
      const idx = keys.indexOf(pinName);
      return {
        x: node.x + node.width,
        y: node.y + headerH + 20 + (idx >= 0 ? idx : 0) * spacing
      };
    } else {
      const keys = Object.keys(node.inputs);
      const idx = keys.indexOf(pinName);
      return {
        x: node.x,
        y: node.y + headerH + 20 + (idx >= 0 ? idx : 0) * spacing
      };
    }
  }

  _onMouseDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const world = this.screenToWorld(sx, sy);

    if (e.button === 1 || e.altKey) {
      // Middle click or Alt -> Pan
      this.isPanning = true;
      this.panStart = { x: sx - this.panX, y: sy - this.panY };
      return;
    }

    // Check pin clicks first
    for (const node of this.nodes) {
      // Outputs
      for (const pinName of Object.keys(node.outputs)) {
        const p = this.getPinCoords(node, pinName, true);
        if (Math.hypot(world.x - p.x, world.y - p.y) < 10) {
          this.isConnecting = true;
          this.connectingFrom = { node, pinName, isOutput: true, x: p.x, y: p.y };
          return;
        }
      }
      // Inputs
      for (const pinName of Object.keys(node.inputs)) {
        const p = this.getPinCoords(node, pinName, false);
        if (Math.hypot(world.x - p.x, world.y - p.y) < 10) {
          this.isConnecting = true;
          this.connectingFrom = { node, pinName, isOutput: false, x: p.x, y: p.y };
          return;
        }
      }
    }

    // Check node drag
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      if (
        world.x >= n.x && world.x <= n.x + n.width &&
        world.y >= n.y && world.y <= n.y + n.height
      ) {
        this.isDraggingNode = true;
        this.draggedNode = n;
        this.dragOffset = { x: world.x - n.x, y: world.y - n.y };
        // Bring to front
        this.nodes.splice(i, 1);
        this.nodes.push(n);
        this.render();
        return;
      }
    }

    // Otherwise pan
    this.isPanning = true;
    this.panStart = { x: sx - this.panX, y: sy - this.panY };
  }

  _onMouseMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const world = this.screenToWorld(sx, sy);

    if (this.isPanning) {
      this.panX = sx - this.panStart.x;
      this.panY = sy - this.panStart.y;
      this.render();
      return;
    }

    if (this.isDraggingNode && this.draggedNode) {
      this.draggedNode.x = world.x - this.dragOffset.x;
      this.draggedNode.y = world.y - this.dragOffset.y;
      this.render();
      return;
    }

    if (this.isConnecting) {
      this.currentMousePos = world;
      this.render();
    }
  }

  _onMouseUp(e) {
    if (this.isPanning) {
      this.isPanning = false;
    }

    if (this.isDraggingNode) {
      this.isDraggingNode = false;
      this.draggedNode = null;
    }

    if (this.isConnecting) {
      const rect = this.canvas.getBoundingClientRect();
      const world = this.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);

      // Look for pin to connect to
      for (const node of this.nodes) {
        if (this.connectingFrom.isOutput) {
          // Connect to input
          for (const pinName of Object.keys(node.inputs)) {
            const p = this.getPinCoords(node, pinName, false);
            if (Math.hypot(world.x - p.x, world.y - p.y) < 14) {
              this._addConnection(this.connectingFrom.node, this.connectingFrom.pinName, node, pinName);
            }
          }
        } else {
          // Connect to output
          for (const pinName of Object.keys(node.outputs)) {
            const p = this.getPinCoords(node, pinName, true);
            if (Math.hypot(world.x - p.x, world.y - p.y) < 14) {
              this._addConnection(node, pinName, this.connectingFrom.node, this.connectingFrom.pinName);
            }
          }
        }
      }

      this.isConnecting = false;
      this.connectingFrom = null;
      this.render();
    }
  }

  _addConnection(fromNode, fromPin, toNode, toPin) {
    if (fromNode.id === toNode.id) return;
    // Replace any existing connection to this specific target input pin
    this.connections = this.connections.filter(c => !(c.toNode.id === toNode.id && c.toPin === toPin));
    this.connections.push({ fromNode, fromPin, toNode, toPin });
  }

  _onWheel(e) {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    this.panX = mx - (mx - this.panX) * zoomFactor;
    this.panY = my - (my - this.panY) * zoomFactor;
    this.zoom *= zoomFactor;
    this.render();
  }

  setExecutingNode(nodeId) {
    this.executingNodeId = nodeId;
    this.render();
  }

  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.zoom, this.zoom);

    // 1. Draw Connections (Wires) - Smooth dark slate with subtle drop shadow
    for (const conn of this.connections) {
      const p1 = this.getPinCoords(conn.fromNode, conn.fromPin, true);
      const p2 = this.getPinCoords(conn.toNode, conn.toPin, false);

      ctx.save();
      ctx.shadowColor = "rgba(0, 0, 0, 0.15)";
      ctx.shadowBlur = 4;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 2;

      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      const dx = Math.abs(p2.x - p1.x) * 0.5;
      ctx.bezierCurveTo(p1.x + dx, p1.y, p2.x - dx, p2.y, p2.x, p2.y);
      ctx.strokeStyle = "#334155";
      ctx.lineWidth = 2.8;
      ctx.lineCap = "round";
      ctx.stroke();
      ctx.restore();
    }

    // Draw active connecting wire (orange dashed with glow)
    if (this.isConnecting && this.connectingFrom && this.currentMousePos) {
      const p1 = { x: this.connectingFrom.x, y: this.connectingFrom.y };
      const p2 = this.currentMousePos;

      ctx.save();
      ctx.shadowColor = "rgba(255, 87, 34, 0.4)";
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      const dx = Math.abs(p2.x - p1.x) * 0.5;
      ctx.bezierCurveTo(p1.x + dx, p1.y, p2.x - dx, p2.y, p2.x, p2.y);
      ctx.strokeStyle = "#ff5722";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.restore();
    }

    // 2. Draw Nodes
    for (const node of this.nodes) {
      this._renderNode(ctx, node);
    }

    ctx.restore();
  }

  _renderNode(ctx, node) {
    const isExecuting = this.executingNodeId === node.id;
    
    // Node Card Shadow & Base (White card on light canvas)
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.08)";
    ctx.shadowBlur = 12;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 4;

    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = isExecuting ? "#16a34a" : "#e2e8f0";
    ctx.lineWidth = isExecuting ? 3 : 1.2;

    ctx.beginPath();
    ctx.roundRect(node.x, node.y, node.width, node.height, 8);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Node Header
    ctx.fillStyle = node.color || "#3b82f6";
    ctx.beginPath();
    ctx.roundRect(node.x, node.y, node.width, 32, [8, 8, 0, 0]);
    ctx.fill();

    // Title
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 12px Inter, sans-serif";
    ctx.fillText(`${node.title} [#${node.id}]`, node.x + 10, node.y + 20);

    // Input Pins
    const headerH = 32;
    const spacing = 22;
    let iIdx = 0;
    ctx.font = "11px Inter, sans-serif";
    for (const [pName, pType] of Object.entries(node.inputs)) {
      const py = node.y + headerH + 20 + iIdx * spacing;
      // Pin dot
      ctx.fillStyle = "#6366f1";
      ctx.beginPath();
      ctx.arc(node.x, py, 5, 0, Math.PI * 2);
      ctx.fill();
      // Label
      ctx.fillStyle = "#334155";
      ctx.fillText(pName, node.x + 12, py + 4);
      iIdx++;
    }

    // Output Pins
    let oIdx = 0;
    for (const [pName, pType] of Object.entries(node.outputs)) {
      const py = node.y + headerH + 20 + oIdx * spacing;
      // Pin dot
      ctx.fillStyle = "#16a34a";
      ctx.beginPath();
      ctx.arc(node.x + node.width, py, 5, 0, Math.PI * 2);
      ctx.fill();
      // Label
      ctx.fillStyle = "#334155";
      const w = ctx.measureText(pName).width;
      ctx.fillText(pName, node.x + node.width - w - 12, py + 4);
      oIdx++;
    }

    // Parameter Summary
    let fIdx = Math.max(iIdx, oIdx);
    ctx.fillStyle = "#64748b";
    for (const [k, v] of Object.entries(node.values)) {
      const py = node.y + headerH + 25 + fIdx * 20;
      const str = `${k}: ${String(v).slice(0, 20)}`;
      ctx.fillText(str, node.x + 12, py);
      fIdx++;
    }
  }

  exportWorkflowJSON() {
    const workflow = {};
    for (const node of this.nodes) {
      const inputs = { ...node.values };
      
      // Wire connections
      for (const conn of this.connections) {
        if (conn.toNode.id === node.id) {
          const outSlot = Object.keys(conn.fromNode.outputs).indexOf(conn.fromPin);
          inputs[conn.toPin] = [conn.fromNode.id, outSlot >= 0 ? outSlot : 0];
        }
      }

      workflow[node.id] = {
        class_type: node.classType,
        inputs: inputs
      };
    }
    return workflow;
  }

  loadWorkflowJSON(workflowData) {
    this.clear();
    const idMap = {};
    let wx = 60;
    let wy = 80;

    for (const [nodeId, nodeData] of Object.entries(workflowData)) {
      const cType = nodeData.class_type || "GenericNode";
      const n = this.addNode(cType, wx, wy);
      n.id = nodeId;
      idMap[nodeId] = n;

      if (nodeData.inputs) {
        for (const [k, v] of Object.entries(nodeData.inputs)) {
          if (!Array.isArray(v)) {
            n.values[k] = v;
          }
        }
      }

      wx += 260;
      if (wx > 800) {
        wx = 60;
        wy += 220;
      }
    }

    // Connect wires
    for (const [nodeId, nodeData] of Object.entries(workflowData)) {
      if (nodeData.inputs) {
        for (const [targetPin, v] of Object.entries(nodeData.inputs)) {
          if (Array.isArray(v) && v.length >= 2) {
            const srcId = String(v[0]);
            const srcSlot = v[1];
            const srcNode = idMap[srcId];
            const tgtNode = idMap[nodeId];

            if (srcNode && tgtNode) {
              const srcPins = Object.keys(srcNode.outputs);
              const fromPin = srcPins[srcSlot] || srcPins[0] || "output";
              this._addConnection(srcNode, fromPin, tgtNode, targetPin);
            }
          }
        }
      }
    }
    this.render();
  }
}

window.GraphCanvas = GraphCanvas;
