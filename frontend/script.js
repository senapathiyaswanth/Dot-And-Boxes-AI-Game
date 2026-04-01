/* ============================================================
   AI Battle Suite — script.js  v3.0
   Modular vanilla-JS frontend for Dots & Boxes
   ============================================================ */

'use strict';

/* ── Constants ───────────────────────────────────────────────── */
const API_BASE = '/api';
const CELL_PX  = 70;   // pixels between dots
const DOT_R    = 6.5;  // half dot-size
const BROWSER_SESSION_KEY = 'dots_boxes_browser_id';
const IS_VERCEL_HOST = location.hostname.endsWith('.vercel.app');
const PLAY_POLL_MS = IS_VERCEL_HOST ? 15000 : 6000;
const AIVAI_POLL_MS = IS_VERCEL_HOST ? 180 : 120;
const AIVAI_HIDDEN_POLL_MS = IS_VERCEL_HOST ? 1200 : 700;
const AI_OVERLAY_DELAY_MS = 140;

function getBrowserSessionId() {
  let sessionId = localStorage.getItem(BROWSER_SESSION_KEY);
  if (!sessionId) {
    const seed = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    sessionId = `browser-${seed}`;
    localStorage.setItem(BROWSER_SESSION_KEY, sessionId);
  }
  return sessionId;
}

function getScopedSessionId(scope = 'default') {
  return `${getBrowserSessionId()}-${scope}`;
}

function withSession(path, sessionId = null) {
  const sep = path.includes('?') ? '&' : '?';
  const scoped = sessionId || getScopedSessionId();
  return `${path}${sep}session_id=${encodeURIComponent(scoped)}`;
}

function getWsUrl(sessionId = null) {
  const base = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`;
  const scoped = sessionId || getScopedSessionId();
  return `${base}?session_id=${encodeURIComponent(scoped)}`;
}

/* ── Utility helpers ─────────────────────────────────────────── */
const $  = id  => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls)  e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

function fmt(v, decimals = 0) {
  if (v === null || v === undefined || v === '' || v === '—') return '—';
  return typeof v === 'number' ? v.toFixed(decimals) : v;
}

function msOrSec(seconds) {
  if (seconds < 0.001) return '<1ms';
  if (seconds < 1)     return (seconds * 1000).toFixed(1) + 'ms';
  return seconds.toFixed(3) + 's';
}

function modeLabel(mode) {
  return { hvh: 'Human vs Human', hvai: 'Human vs AI', aivai: 'AI vs AI' }[mode] || mode;
}

function strategyLabel(s) {
  return { minimax: 'Minimax', alphabeta: 'Alpha-Beta', adaptive: 'Adaptive AI' }[s] || s;
}

function isDocumentVisible() {
  return !document.hidden;
}

function winnerText(w) {
  if (w === 1) return 'Player 1 Wins! 🎉';
  if (w === 2) return 'Player 2 Wins! 🤖';
  return "It's a Draw! 🤝";
}

/* ── Toast notifications ─────────────────────────────────────── */
const Toast = {
  show(msg, type = 'info', duration = 3000) {
    const t = el('div', `toast ${type}`, `<span>${msg}</span>`);
    $('toast-container').appendChild(t);
    setTimeout(() => t.remove(), duration);
  },
};

/* ── Confetti ────────────────────────────────────────────────── */
function launchConfetti() {
  const colors = ['#2563eb','#dc2626','#16a34a','#d97706','#8b5cf6','#ec4899'];
  for (let i = 0; i < 70; i++) {
    const p = el('div', 'confetti-piece');
    p.style.cssText = `
      left: ${Math.random() * 100}vw;
      top: -10px;
      background: ${colors[Math.floor(Math.random() * colors.length)]};
      width: ${6 + Math.random() * 6}px;
      height: ${6 + Math.random() * 6}px;
      border-radius: ${Math.random() > 0.5 ? '50%' : '2px'};
      animation-delay: ${Math.random() * 0.8}s;
      animation-duration: ${2 + Math.random() * 1.5}s;
    `;
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 3000);
  }
}

/* ── API Client ──────────────────────────────────────────────── */
const API = {
  async get(path, opts = {}) {
    const r = await fetch(API_BASE + withSession(path, opts.sessionId));
    if (!r.ok) throw new Error(`API ${path}: ${r.status}`);
    return r.json();
  },
  async post(path, body = {}, opts = {}) {
    const r = await fetch(API_BASE + withSession(path, opts.sessionId), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ message: 'Unknown error' }));
      throw new Error(err.message || `API ${path}: ${r.status}`);
    }
    return r.json();
  },
};

/* ── WebSocket Client ────────────────────────────────────────── */
const WS = {
  socket: null,
  sessionId: null,
  handlers: {},
  reconnectTimer: null,

  connect(sessionId = null) {
    if (sessionId) this.sessionId = sessionId;
    if (!this.sessionId) this.sessionId = getScopedSessionId('dashboard');
    if (IS_VERCEL_HOST) {
      const dot = $('conn-dot');
      const lbl = $('conn-label');
      if (dot) dot.classList.add('connected');
      if (lbl) lbl.textContent = 'Polling mode';
      return;
    }
    if (this.socket && this.socket.readyState < 2) return;
    try {
      this.socket = new WebSocket(getWsUrl(this.sessionId));
      this.socket.onopen    = () => this._onOpen();
      this.socket.onmessage = e  => this._onMessage(e);
      this.socket.onclose   = () => this._onClose();
      this.socket.onerror   = () => {};
    } catch {
      this._onClose();
    }
  },

  _onOpen() {
    const dot = $('conn-dot');
    const lbl = $('conn-label');
    dot.classList.add('connected');
    lbl.textContent = 'Connected';
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  },

  _onClose() {
    if (IS_VERCEL_HOST) return;
    const dot = $('conn-dot');
    const lbl = $('conn-label');
    dot.classList.remove('connected');
    lbl.textContent = 'Reconnecting…';
    this.reconnectTimer = setTimeout(() => this.connect(this.sessionId), 2000);
  },

  _onMessage(event) {
    try {
      const msg = JSON.parse(event.data);
      (this.handlers[msg.type] || []).forEach(fn => fn(msg.data));
    } catch {}
  },

  on(type, fn) {
    if (!this.handlers[type]) this.handlers[type] = [];
    this.handlers[type].push(fn);
  },

  off(type, fn) {
    if (!this.handlers[type]) return;
    this.handlers[type] = this.handlers[type].filter(h => h !== fn);
  },

  setSession(sessionId) {
    if (!sessionId || this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try { this.socket.close(); } catch {}
      this.socket = null;
    }
    this.connect(sessionId);
  },
};

/* ── Sidebar Navigation ──────────────────────────────────────── */
const Nav = {
  current: 'dashboard',
  sidebarOpen: false,

  init() {
    document.querySelectorAll('.nav-item[data-section]').forEach(item => {
      item.addEventListener('click', () => this.go(item.dataset.section));
    });
    $('mobile-menu-btn')?.addEventListener('click', () => this.toggleSidebar());
    $('sidebar-backdrop')?.addEventListener('click', () => this.closeSidebar());
    window.addEventListener('resize', () => {
      if (window.innerWidth > 768) this.closeSidebar(true);
    });
  },

  go(section) {
    // Hide all pages
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    // Show target
    const page = $(`section-${section}`);
    const nav  = $(`nav-${section}`);
    if (page) page.classList.add('active');
    if (nav)  nav.classList.add('active');
    this.current = section;
    if (location.hash !== `#${section}`) {
      history.replaceState(null, '', `#${section}`);
    }
    this.closeSidebar();
    App.syncLiveSession(section);

    // Lazy-load section data
    if (section === 'history')    History.load();
    if (section === 'comparison') ChartMgr.activateComparisonView();
    if (section === 'dashboard')  Dashboard.load();
  },

  toggleSidebar(force = null) {
    const shouldOpen = force ?? !this.sidebarOpen;
    const sidebar = $('sidebar');
    const backdrop = $('sidebar-backdrop');
    const button = $('mobile-menu-btn');
    this.sidebarOpen = !!shouldOpen;
    sidebar?.classList.toggle('open', this.sidebarOpen);
    backdrop?.classList.toggle('open', this.sidebarOpen);
    button?.classList.toggle('open', this.sidebarOpen);
    if (button) button.setAttribute('aria-expanded', this.sidebarOpen ? 'true' : 'false');
    document.body.style.overflow = this.sidebarOpen && window.innerWidth <= 768 ? 'hidden' : '';
  },

  closeSidebar(skipIfDesktop = false) {
    if (skipIfDesktop && window.innerWidth > 768) return;
    this.toggleSidebar(false);
  },
};

/* ── Chart Manager ───────────────────────────────────────────── */
const ChartMgr = {
  nodes: null, time: null, history: null, qvalues: null,
  // Move counter per game session — ensures correct X-axis labels
  _moveCount: 0,

  _barOpts(labels, datasets) {
    return {
      type: 'bar',
      data: { labels, datasets },
      options: {
        animation: false,
        responsive: true,
        plugins: { legend: { display: true, position: 'top' } },
        scales: {
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(0,0,0,0.05)' },
            ticks: { color: '#64748b', font: { size: 11 } },
          },
          x: {
            grid: { display: false },
            ticks: { color: '#64748b', font: { size: 11 } },
          },
        },
      },
    };
  },

  initComparisonCharts() {
    const ctx1 = $('chart-nodes');
    const ctx2 = $('chart-time');
    if (!ctx1 || !ctx2) return;
    if (this.nodes) { this.nodes.destroy(); }
    if (this.time)  { this.time.destroy();  }

    this.nodes = new Chart(ctx1, this._barOpts(
      ['Minimax', 'Alpha-Beta'],
      [{
        label: 'Nodes Explored',
        data: [0, 0],
        backgroundColor: ['rgba(37,99,235,0.7)', 'rgba(220,38,38,0.7)'],
        borderColor:      ['#2563eb', '#dc2626'],
        borderWidth: 2,
        borderRadius: 6,
      }],
    ));

    this.time = new Chart(ctx2, this._barOpts(
      ['Minimax', 'Alpha-Beta'],
      [{
        label: 'Time (s)',
        data: [0, 0],
        backgroundColor: ['rgba(37,99,235,0.7)', 'rgba(220,38,38,0.7)'],
        borderColor:      ['#2563eb', '#dc2626'],
        borderWidth: 2,
        borderRadius: 6,
      }],
    ));
  },

  activateComparisonView() {
    this.initComparisonCharts();
    this.initHistoryChart();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.nodes?.resize();
        this.time?.resize();
        this.history?.resize();
        this.nodes?.update('none');
        this.time?.update('none');
        this.history?.update('none');
      });
    });
  },

  updateComparisonCharts(mmNodes, abNodes, mmTime, abTime) {
    if (!this.nodes || !this.time) this.initComparisonCharts();
    this.nodes.data.datasets[0].data = [mmNodes, abNodes];
    this.nodes.update();
    this.time.data.datasets[0].data  = [mmTime, abTime];
    this.time.update();
  },

  /**
   * Initialize the Nodes-per-Move history line chart.
   * Safe to call even before the canvas is visible.
   * Guards against double-init — call resetHistoryChart() to clear for a new game.
   */
  initHistoryChart() {
    const ctx = $('chart-history');
    if (!ctx) return;
    if (this.history) return; // already initialised — call resetHistoryChart() to clear
    this._moveCount = 0;
    this.history = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Minimax Nodes',
            data: [],
            borderColor: '#2563eb',
            backgroundColor: 'rgba(37,99,235,0.08)',
            tension: 0.35,
            fill: true,
            pointRadius: 3,
            spanGaps: true,
          },
          {
            label: 'Alpha-Beta / Adaptive Nodes',
            data: [],
            borderColor: '#dc2626',
            backgroundColor: 'rgba(220,38,38,0.08)',
            tension: 0.35,
            fill: true,
            pointRadius: 3,
            spanGaps: true,
          },
        ],
      },
      options: {
        animation: false,          // critical for real-time responsiveness
        responsive: true,
        plugins: { legend: { position: 'top' } },
        scales: {
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(0,0,0,0.05)' },
            ticks: { color: '#64748b', font: { size: 11 } },
          },
          x: {
            grid: { display: false },
            ticks: { color: '#64748b', font: { size: 11 } },
          },
        },
      },
    });
  },

  /**
   * Reset the Nodes-per-Move chart for a fresh game session.
   * Destroys existing chart instance and clears move counter.
   */
  resetHistoryChart() {
    if (this.history) {
      this.history.destroy();
      this.history = null;
    }
    this._moveCount = 0;
    this.initHistoryChart();
  },

  /**
   * Push one AI move's node count onto the live graph.
   * FIX: Corrected strategy → dataset mapping (minimax=0, everything else=1).
   * FIX: Auto-initialises chart if not yet done.
   * FIX: Removed duplicate label guard — each call = one X axis point.
   * @param {string} strategy  'minimax' | 'alphabeta' | 'adaptive'
   * @param {number} nodes     Number of nodes the AI expanded this move
   */
  pushHistoryPoint(strategy, nodes) {
    if (!this.history) this.initHistoryChart();
    if (!this.history) return;   // canvas not in DOM yet, skip

    this._moveCount++;
    const label = `M${this._moveCount}`;

    // Extend both datasets with null so spanGaps renders continuous lines
    this.history.data.labels.push(label);
    this.history.data.datasets[0].data.push(null);
    this.history.data.datasets[1].data.push(null);

    const idx = this.history.data.labels.length - 1;

    // Map strategy to dataset index:
    //   0 → Minimax
    //   1 → Alpha-Beta or Adaptive (both non-minimax)
    if (strategy === 'minimax') {
      this.history.data.datasets[0].data[idx] = nodes;
    } else {
      this.history.data.datasets[1].data[idx] = nodes;
    }

    // Keep a rolling window of last 30 moves
    const MAX = 30;
    if (this.history.data.labels.length > MAX) {
      this.history.data.labels.shift();
      this.history.data.datasets.forEach(d => d.data.shift());
    }

    this.history.update('none');  // 'none' = no animation, instant update
  },

  initQChart(labels, values) {
    const ctx = $('chart-qvalues');
    if (!ctx) return;
    if (this.qvalues) this.qvalues.destroy();
    this.qvalues = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Q-Value',
          data: values,
          backgroundColor: values.map(v => v >= 0 ? 'rgba(34,197,94,0.7)' : 'rgba(220,38,38,0.7)'),
          borderColor:     values.map(v => v >= 0 ? '#16a34a' : '#dc2626'),
          borderWidth: 2,
          borderRadius: 4,
        }],
      },
      options: {
        animation: false,
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          y: { grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { color: '#64748b', font: { size: 10 } } },
          x: { grid: { display: false }, ticks: { color: '#64748b', font: { size: 9 } } },
        },
      },
    });
  },
};

/* ── Game Board Renderer ─────────────────────────────────────── */
class GameBoard {
  constructor(containerId, opts = {}) {
    this.containerId = containerId;
    this.onLineClick = opts.onLineClick || null;
    this.readOnly    = opts.readOnly    || false;
    this.state       = null;
    this.suggestedMove = null;
    this.pendingMove = null;
  }

  render(state) {
    this.state = state;
    const container = $(this.containerId);
    if (!container) return;

    const { rows, cols, horizontal_lines, vertical_lines, boxes } = state;
    const W = cols * CELL_PX;
    const H = rows * CELL_PX;

    container.style.cssText = `width:${W}px;height:${H}px;`;
    container.innerHTML = '';

    // Dots
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const dot = el('div', 'dot');
        dot.style.left = `${c * CELL_PX}px`;
        dot.style.top  = `${r * CELL_PX}px`;
        container.appendChild(dot);
      }
    }

    // Horizontal lines
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c < cols; c++) {
        const line = el('div', 'line h');
        line.dataset.type = 'h'; line.dataset.r = r; line.dataset.c = c;
        line.style.left  = `${c * CELL_PX + DOT_R}px`;
        line.style.top   = `${r * CELL_PX}px`;
        line.style.width = `${CELL_PX - DOT_R * 2}px`;

        if (horizontal_lines[r][c]) {
          const who = this._lineOwner(state, 'h', r, c);
          line.classList.add(who === 1 ? 'drawn-p1' : 'drawn-p2');
        } else if (!state.is_game_over && !this.readOnly) {
          line.classList.add('available');
          line.addEventListener('pointerup',   e => {
            e.preventDefault();
            this._handleClick('h', r, c);
          });
          line.addEventListener('mouseenter',  () => line.classList.add('hover'));
          line.addEventListener('mouseleave',  () => line.classList.remove('hover'));
        }

        // Suggestion highlight
        if (this.suggestedMove &&
            this.suggestedMove.type === 'h' &&
            this.suggestedMove.r === r &&
            this.suggestedMove.c === c) {
          line.classList.remove('available');
          line.classList.add('suggested');
        }

        if (this.pendingMove &&
            this.pendingMove.type === 'h' &&
            this.pendingMove.r === r &&
            this.pendingMove.c === c) {
          line.classList.remove('available');
          line.classList.add('pending');
        }

        container.appendChild(line);
      }
    }

    // Vertical lines
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const line = el('div', 'line v');
        line.dataset.type = 'v'; line.dataset.r = r; line.dataset.c = c;
        line.style.left   = `${c * CELL_PX}px`;
        line.style.top    = `${r * CELL_PX + DOT_R}px`;
        line.style.height = `${CELL_PX - DOT_R * 2}px`;

        if (vertical_lines[r][c]) {
          const who = this._lineOwner(state, 'v', r, c);
          line.classList.add(who === 1 ? 'drawn-p1' : 'drawn-p2');
        } else if (!state.is_game_over && !this.readOnly) {
          line.classList.add('available');
          line.addEventListener('pointerup',   e => {
            e.preventDefault();
            this._handleClick('v', r, c);
          });
          line.addEventListener('mouseenter',  () => line.classList.add('hover'));
          line.addEventListener('mouseleave',  () => line.classList.remove('hover'));
        }

        if (this.suggestedMove &&
            this.suggestedMove.type === 'v' &&
            this.suggestedMove.r === r &&
            this.suggestedMove.c === c) {
          line.classList.remove('available');
          line.classList.add('suggested');
        }

        if (this.pendingMove &&
            this.pendingMove.type === 'v' &&
            this.pendingMove.r === r &&
            this.pendingMove.c === c) {
          line.classList.remove('available');
          line.classList.add('pending');
        }

        container.appendChild(line);
      }
    }

    // Boxes
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (boxes[r][c]) {
          const box = el('div', `box p${boxes[r][c]}`);
          box.style.left   = `${c * CELL_PX + DOT_R}px`;
          box.style.top    = `${r * CELL_PX + DOT_R}px`;
          box.style.width  = `${CELL_PX - DOT_R * 2}px`;
          box.style.height = `${CELL_PX - DOT_R * 2}px`;
          const lbl = el('div', 'box-label', `P${boxes[r][c]}`);
          box.appendChild(lbl);
          container.appendChild(box);
          // Trigger animation
          requestAnimationFrame(() => box.classList.add('filled'));
        }
      }
    }
  }

  _handleClick(type, r, c) {
    if (!this.onLineClick || !this.state || this.state.is_game_over) return;
    this.onLineClick(type, r, c);
  }

  _lineOwner(state, type, r, c) {
    // Check adjacent boxes to determine which player owns this drawn line
    const { rows, cols, boxes } = state;
    if (type === 'h') {
      if (r > 0 && boxes[r-1][c] > 0) return boxes[r-1][c];
      if (r < rows && boxes[r][c] > 0) return boxes[r][c];
    } else {
      if (c > 0 && boxes[r][c-1] > 0)   return boxes[r][c-1];
      if (c < cols && boxes[r][c] > 0)   return boxes[r][c];
    }
    // Line is drawn but no adjacent box captured — assign to the non-current player
    // (the player who drew this line has already taken their turn)
    return state.current_player === 1 ? 2 : 1;
  }

  setSuggestion(move) {
    this.suggestedMove = move;
    if (this.state) this.render(this.state);
  }

  clearSuggestion() {
    this.suggestedMove = null;
    if (this.state) this.render(this.state);
  }

  setPendingMove(move) {
    this.pendingMove = move;
    if (this.state) this.render(this.state);
  }

  clearPendingMove() {
    this.pendingMove = null;
    if (this.state) this.render(this.state);
  }
}

/* ── Play Section Factory ─────────────────────────────────────
   Creates the full game UI for both Minimax and Alpha-Beta sections
   ──────────────────────────────────────────────────────────── */
class PlaySection {
  constructor(rootId, strategy) {
    this.rootId           = rootId;
    this.strategy         = strategy;  // 'minimax' | 'alphabeta'
    this.sessionId        = getScopedSessionId(`play-${strategy}`);
    this.mode             = 'hvai';    // hvh | hvai
    this.depth            = 3;
    this.rows             = 4;
    this.cols             = 4;
    this.board            = null;
    this.aiLocked         = false;
    this.aiRequestInFlight = false;    // prevents concurrent AI requests
    this.log              = [];
    this.gameOverShown    = false;
    this.pollTimer        = null;
    this.pollInFlight     = false;
    this.hasStarted       = false;
    this.lastStateVersion = null;
    this._wsHandler  = null;
    this._wsMetrics  = null;
    this._wsGameOver = null;
    this.overlayTimer = null;
    this.build();
  }

  build() {
    const root = $(this.rootId);
    if (!root) return;
    const prefix = this.strategy === 'minimax' ? 'mm' : 'ab';

    root.innerHTML = `
      <!-- Controls card -->
      <div class="card" style="margin-bottom:1.25rem;">
        <div class="card-header">
          <span class="card-title">⚙️ Game Setup</span>
          <button class="btn btn-blue btn-sm" id="${prefix}-btn-new">▶ New Game</button>
        </div>
        <div class="card-body">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Game Mode</label>
              <select class="select-ctrl" id="${prefix}-mode">
                <option value="hvh">👥 Human vs Human</option>
                <option value="hvai" selected>🤖 Human vs AI</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Grid Size</label>
              <select class="select-ctrl" id="${prefix}-grid-size">
                <option value="3">3 × 3</option>
                <option value="4" selected>4 × 4</option>
                <option value="5">5 × 5</option>
                <option value="6">6 × 6</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">AI Depth</label>
              <div class="diff-pills" id="${prefix}-depth-pills">
                <span class="diff-pill" data-val="1">1</span>
                <span class="diff-pill" data-val="2">2</span>
                <span class="diff-pill active" data-val="3">3</span>
                <span class="diff-pill" data-val="4">4</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Game layout -->
      <div class="game-layout">
        <!-- Left: score + board -->
        <div class="board-wrapper">
          <div class="score-bar">
            <div class="score-player">
              <div class="score-avatar p1">P1</div>
              <div class="score-info">
                <div class="score-name">Player 1</div>
                <div class="score-val p1" id="${prefix}-score1">0</div>
              </div>
            </div>
            <div class="turn-badge">
              <div class="turn-label">Current Turn</div>
              <div class="turn-pill p1" id="${prefix}-turn">Player 1</div>
            </div>
            <div class="score-player" style="justify-content:flex-end;">
              <div class="score-info" style="text-align:right;">
                <div class="score-name" id="${prefix}-p2-label">AI (${this.strategy === 'minimax' ? 'Minimax' : 'Alpha-Beta'})</div>
                <div class="score-val p2" id="${prefix}-score2">0</div>
              </div>
              <div class="score-avatar p2" style="margin-left:0.65rem;">AI</div>
            </div>
          </div>

          <div class="card board-card" style="position:relative;">
            <div class="board-overlay" id="${prefix}-overlay">
              <div class="thinking-spinner">
                <div class="spinner-ring"></div>
                <div class="thinking-text">AI Thinking…</div>
              </div>
            </div>
            <div id="${prefix}-grid" class="grid"></div>
          </div>

          <div class="flex items-center justify-between" style="gap:0.75rem;flex-wrap:wrap;">
            <button class="btn btn-outline-blue btn-sm" id="${prefix}-suggest">💡 Suggest Move</button>
            <button class="btn btn-ghost btn-sm" id="${prefix}-reset">↺ Reset Board</button>
            <button class="btn btn-ghost btn-sm" id="${prefix}-clear-sug">✕ Clear Hint</button>
          </div>
        </div>

        <!-- Right: metrics panel -->
        <div class="controls-panel">
          <div class="card">
            <div class="card-header"><span class="card-title">📡 AI Metrics</span></div>
            <div class="card-body">
              <div class="metrics-grid">
                <div class="metric-tile">
                  <div class="metric-tile-label">Nodes</div>
                  <div class="metric-tile-value blue" id="${prefix}-nodes">—</div>
                </div>
                <div class="metric-tile">
                  <div class="metric-tile-label">Pruned</div>
                  <div class="metric-tile-value red" id="${prefix}-pruned">—</div>
                </div>
                <div class="metric-tile">
                  <div class="metric-tile-label">Time</div>
                  <div class="metric-tile-value purple" id="${prefix}-time">—</div>
                </div>
                <div class="metric-tile">
                  <div class="metric-tile-label">Q-Value</div>
                  <div class="metric-tile-value green" id="${prefix}-qval">—</div>
                </div>
              </div>
              <!-- Q bar -->
              <div class="q-bar-wrap mt-2">
                <div class="metric-tile-label" style="margin-bottom:0.3rem;">Learned Confidence</div>
                <div class="q-bar-track">
                  <div class="q-bar-fill" id="${prefix}-qbar" style="width:0%"></div>
                </div>
                <div class="q-bar-labels">
                  <span>−10</span><span>+10</span>
                </div>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-header"><span class="card-title">📋 Move History</span></div>
            <div class="card-body">
              <div class="log-box" id="${prefix}-log"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Wire up events
    this._wire(prefix);
  }

  _wire(prefix) {
    $(`${prefix}-btn-new`).onclick = () => this._startGame();
    $(`${prefix}-reset`).onclick   = () => this._reset();
    $(`${prefix}-suggest`).onclick  = () => this._suggest();
    $(`${prefix}-clear-sug`).onclick= () => {
      if (this.board) this.board.clearSuggestion();
    };

    // Depth pills
    document.querySelectorAll(`#${prefix}-depth-pills .diff-pill`).forEach(pill => {
      pill.addEventListener('click', () => {
        document.querySelectorAll(`#${prefix}-depth-pills .diff-pill`).forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        this.depth = parseInt(pill.dataset.val);
      });
    });

    // WS handlers
    if (this._wsHandler) WS.off('state', this._wsHandler);
    if (this._wsMetrics) WS.off('metrics', this._wsMetrics);
    if (this._wsGameOver) WS.off('game_over', this._wsGameOver);

    this._wsHandler = data => this._onState(data, prefix);
    this._wsMetrics = data => this._onMetrics(data, prefix);
    this._wsGameOver = data => this._onGameOver(data);
    WS.on('state',    this._wsHandler);
    WS.on('metrics',  this._wsMetrics);
    WS.on('game_over', this._wsGameOver);
  }

  startPolling() {
    if (this.pollTimer) return;
    const tick = async () => {
      if (this.pollInFlight) return;
      if (!document.getElementById(`section-play-${this.strategy}`)?.classList.contains('active')) return;
      if (!isDocumentVisible()) return;
      this.pollInFlight = true;
      try {
        const prefix = this.strategy === 'minimax' ? 'mm' : 'ab';
        const state = await API.get('/state', { sessionId: this.sessionId });
        this._onState(state, prefix);
      } catch {}
      finally {
        this.pollInFlight = false;
        this.pollTimer = setTimeout(tick, PLAY_POLL_MS);
      }
    };
    tick();
  }

  stopPolling() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    this.pollTimer = null;
    this.pollInFlight = false;
  }

  async _startGame() {
    const prefix = this.strategy === 'minimax' ? 'mm' : 'ab';
    this.mode = $(`${prefix}-mode`).value;
    this.rows = parseInt($(`${prefix}-grid-size`).value);
    this.cols = this.rows;
    Modal.hide();
    this.log  = [];
    this.aiLocked = false;
    this.aiRequestInFlight = false;  // reset to prevent stuck-AI state on new game
    this.gameOverShown = false;
    this.lastStateVersion = null;
    this._clearOverlayTimer();

    if (this.board) { this.board.onLineClick = null; }

    // Reset the live nodes-per-move chart for this new session
    ChartMgr.resetHistoryChart();

    // Update P2 label
    const p2lbl = $(`${prefix}-p2-label`);
    if (p2lbl) {
      p2lbl.textContent = this.mode === 'hvh'
        ? 'Player 2'
        : `AI (${strategyLabel(this.strategy)})`;
    }
    const aiAvatar = document.querySelector(`#${this.rootId} .score-avatar.p2`);
    if (aiAvatar) aiAvatar.textContent = this.mode === 'hvh' ? 'P2' : 'AI';

    try {
      const res = await API.post('/start-game', {
        rows:     this.rows,
        cols:     this.cols,
        mode:     this.mode,
        strategy: this.strategy,
      }, { sessionId: this.sessionId });
      this.hasStarted = true;
      const state = res.state || await API.get('/state', { sessionId: this.sessionId });
      this._onState(state, prefix);
      this._addLog('sys', '⬡ New game started');
    } catch (e) {
      Toast.show('Failed to start game: ' + e.message, 'error');
    }
  }

  async _reset() {
    Modal.hide();
    this.log = [];
    this.aiLocked = false;
    this.aiRequestInFlight = false;
    this.gameOverShown = false;
    this.lastStateVersion = null;
    this._clearOverlayTimer();
    try {
      const res = await API.post('/reset', {}, { sessionId: this.sessionId });
      const prefix = this.strategy === 'minimax' ? 'mm' : 'ab';
      const state = res.state || await API.get('/state', { sessionId: this.sessionId });
      this._onState(state, prefix);
      this._addLog('sys', '↺ Board reset');
    } catch (e) {
      Toast.show('Reset failed: ' + e.message, 'error');
    }
  }

  _onState(state, prefix) {
    // Only update if this section is active
    if (!document.getElementById(`section-play-${this.strategy}`).classList.contains('active')) return;
    const version = state?.state_version;
    if (version !== undefined && version === this.lastStateVersion) return;
    if (version !== undefined) this.lastStateVersion = version;

    if (!this.board) {
      this.board = new GameBoard(`${prefix}-grid`, {
        onLineClick: (type, r, c) => this._onHumanMove(type, r, c),
      });
    } else {
      this.board.onLineClick = (type, r, c) => this._onHumanMove(type, r, c);
    }

    this.board.render(state);

    // Update score
    const s1 = $(`${prefix}-score1`);
    const s2 = $(`${prefix}-score2`);
    if (s1) s1.textContent = state.scores[1] ?? state.scores['1'] ?? 0;
    if (s2) s2.textContent = state.scores[2] ?? state.scores['2'] ?? 0;

    // Update turn pill
    const turn = $(`${prefix}-turn`);
    if (turn) {
      const isP1 = state.current_player === 1;
      turn.textContent = isP1 ? 'Player 1' : (this.mode === 'hvh' ? 'Player 2' : `AI (${strategyLabel(this.strategy)})`);
      turn.className   = `turn-pill ${isP1 ? 'p1' : 'p2'}`;
    }

    if (state.is_game_over) {
      this.aiLocked = false;
      this.aiRequestInFlight = false;
      if (!this.gameOverShown) {
        this.gameOverShown = true;
        this._showGameOver({
          scores: state.scores,
          winner: this._winnerFromScores(state.scores),
        });
      }
      return;
    }

    // Trigger AI's turn if it's active and not already triggered
    if (this.mode === 'hvai' && state.current_player === 2) {
      if (!this.aiRequestInFlight) {
        this._triggerAI();
      }
    } else if (state.current_player === 1 || this.mode === 'hvh') {
      this.aiLocked = false;
    }
  }

  _onMetrics(data, prefix) {
    if (!document.getElementById(`section-play-${this.strategy}`).classList.contains('active')) return;

    const nodes = data.nodes ?? '—';
    const pruned = data.pruned ?? '—';
    const time   = typeof data.time === 'number' ? msOrSec(data.time) : '—';
    const qval  = typeof data.q_value === 'number' ? data.q_value.toFixed(3) : '—';

    set($(`${prefix}-nodes`),  nodes);
    set($(`${prefix}-pruned`), pruned);
    set($(`${prefix}-time`),   time);
    set($(`${prefix}-qval`),   qval);

    // Q bar
    if (typeof data.q_value === 'number') {
      const pct = Math.min(100, Math.max(0, ((data.q_value + 10) / 20) * 100));
      const bar = $(`${prefix}-qbar`);
      if (bar) bar.style.width = pct + '%';
    }

    // History chart
    if (data.nodes && data.strategy) {
      ChartMgr.pushHistoryPoint(data.strategy, data.nodes);
    }

    function set(el, val) { if (el) el.textContent = val; }
  }

  _onGameOver(data) {
    if (!document.getElementById(`section-play-${this.strategy}`).classList.contains('active')) return;
    if (this.gameOverShown) return;
    this.gameOverShown = true;
    this._showGameOver(data);
  }

  async _onHumanMove(type, r, c) {
    if (this.aiLocked) return;
    this.aiLocked = true;
    if (this.board) {
      this.board.setPendingMove({ type, r, c });
    }
    try {
      const res = await API.post('/move', { m_type: type, r, c }, { sessionId: this.sessionId });
      if (res.state) {
        const prefix = this.strategy === 'minimax' ? 'mm' : 'ab';
        this._onState(res.state, prefix);
      }
      this._addLog(1, `P1 drew ${type.toUpperCase()} line at (${r},${c})`);
      if (this.board) this.board.clearSuggestion();
    } catch (e) {
      this.aiLocked = false;
      Toast.show('Invalid move: ' + e.message, 'error');
    } finally {
      if (this.board) this.board.clearPendingMove();
    }
  }

  async _triggerAI() {
    if (this.aiRequestInFlight) return;
    this.aiRequestInFlight = true;
    this.aiLocked = true;

    const prefix = this.strategy === 'minimax' ? 'mm' : 'ab';
    const overlay = $(`${prefix}-overlay`);
    this._clearOverlayTimer();
    if (overlay) {
      this.overlayTimer = setTimeout(() => {
        if (this.aiRequestInFlight) overlay.classList.add('active');
      }, AI_OVERLAY_DELAY_MS);
    }

    try {
      // Map depth pill → difficulty: 1=easy, 2=medium, 3/4=hard, 5+=expert
      const _diffMap = {1:'easy', 2:'medium', 3:'hard', 4:'hard'};
      const _diff = _diffMap[this.depth] || 'hard';
      const res = await API.post('/ai-move', {
        strategy:   this.strategy,
        depth:      this.depth,
        difficulty: _diff,
      }, { sessionId: this.sessionId });
      if (res.state) {
        this._onState(res.state, prefix);
      }
      if (res.metrics) {
        this._onMetrics(res.metrics, prefix);
      }
      if (res.move) {
        this._addLog(2, `AI drew ${res.move.type.toUpperCase()} line at (${res.move.r},${res.move.c})`);
      }
      // NOTE: Do NOT push to ChartMgr here
    } catch (e) {
      Toast.show('AI move failed: ' + e.message, 'error');
    } finally {
      this._clearOverlayTimer();
      if (overlay) overlay.classList.remove('active');
      this.aiRequestInFlight = false;

      // If the game is over, ensure the UI reflects it immediately
      if (this.board && this.board.state && this.board.state.is_game_over) {
        this.aiLocked = false;
        return;
      }

      // If it's still AI's turn, trigger next move in chain
      if (this.board && this.board.state && 
          this.mode === 'hvai' && 
          this.board.state.current_player === 2) {
        
        setTimeout(() => {
          if (!this.board.state.is_game_over && 
              $(`section-play-${this.strategy}`).classList.contains('active')) {
            this._triggerAI();
          }
        }, 60); // Keep chained AI turns feeling responsive
      } else {
        this.aiLocked = false;
      }
    }
  }

  async _suggest() {
    try {
      const res = await API.get(`/suggest?depth=${this.depth}`, { sessionId: this.sessionId });
      if (res.move && this.board) {
        this.board.setSuggestion(res.move);
        Toast.show(`💡 Suggested: ${res.move.type.toUpperCase()}(${res.move.r},${res.move.c})`, 'info');
      }
    } catch (e) {
      Toast.show('Suggest failed: ' + e.message, 'error');
    }
  }

  _addLog(player, text) {
    const prefix = this.strategy === 'minimax' ? 'mm' : 'ab';
    const logBox = $(`${prefix}-log`);
    if (!logBox) return;
    const entry = el('div', `log-entry ${player === 'sys' ? 'log-sys' : `log-p${player}`}`, text);
    logBox.prepend(entry);
    // Keep last 40
    while (logBox.children.length > 40) logBox.lastChild.remove();
  }

  _showGameOver(data) {
    this.aiLocked = false;
    this.aiRequestInFlight = false;
    this._clearOverlayTimer();
    const scores = data.scores || {};
    const winner = data.winner ?? 0;
    Modal.show(scores, winner, () => this._startGame(), this.mode);
    if (winner !== 0) launchConfetti();
  }

  _clearOverlayTimer() {
    if (!this.overlayTimer) return;
    clearTimeout(this.overlayTimer);
    this.overlayTimer = null;
  }

  _winnerFromScores(scores) {
    const p1 = scores?.[1] ?? scores?.['1'] ?? 0;
    const p2 = scores?.[2] ?? scores?.['2'] ?? 0;
    if (p1 > p2) return 1;
    if (p2 > p1) return 2;
    return 0;
  }
}

/* ── AI vs AI Controller ─────────────────────────────────────── */
const AiVsAi = {
  _ws1: null, _ws2: null, _ws3: null,
  board: null,
  running: false,
  gameOverShown: false,
  pollTimer: null,
  pollInFlight: false,
  sessionId: getScopedSessionId('aivai'),
  lastStateVersion: null,

  init() {
    $('btn-aivai-start').onclick = () => this.start();
    $('btn-aivai-reset').onclick = () => this.reset();

    // Depth pills
    document.querySelectorAll('#aivai-depth-pills .diff-pill').forEach(p => {
      p.addEventListener('click', () => {
        document.querySelectorAll('#aivai-depth-pills .diff-pill').forEach(x => x.classList.remove('active'));
        p.classList.add('active');
      });
    });

    // WS
    if (this._ws1) WS.off('state', this._ws1);
    if (this._ws2) WS.off('metrics', this._ws2);
    if (this._ws3) WS.off('game_over', this._ws3);

    this._ws1 = data => this._onState(data);
    this._ws2 = data => this._onMetrics(data);
    this._ws3 = data => this._onGameOver(data);
    WS.on('state',    this._ws1);
    WS.on('metrics',  this._ws2);
    WS.on('game_over', this._ws3);
  },

  startPolling() {
    if (this.pollTimer) return;
    const tick = async () => {
      if (this.pollInFlight) return;
      if (!$('section-aivai')?.classList.contains('active') || !this.running) return;
      this.pollInFlight = true;
      try {
        const state = await API.get('/state', { sessionId: this.sessionId });
        this._onState(state);
      } catch {}
      finally {
        this.pollInFlight = false;
        const delay = isDocumentVisible() ? AIVAI_POLL_MS : AIVAI_HIDDEN_POLL_MS;
        this.pollTimer = setTimeout(tick, delay);
      }
    };
    tick();
  },

  stopPolling() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    this.pollTimer = null;
    this.pollInFlight = false;
  },

  async start() {
    Modal.hide();
    const strat1 = $('aivai-strat1-sel').value;
    const strat2 = $('aivai-strat2-sel').value;
    const active = document.querySelector('#aivai-depth-pills .diff-pill.active');
    const rawDepth = active ? parseInt(active.dataset.val) : 1;
    const depth  = IS_VERCEL_HOST ? Math.min(rawDepth, 2) : rawDepth;
    const rawDelay  = parseFloat($('aivai-delay').value);
    const delay  = IS_VERCEL_HOST ? Math.min(rawDelay, 0.05) : rawDelay;
    const rows   = parseInt($('aivai-grid-size').value);
    const cols   = rows;

    $('aivai-strat1').textContent = strategyLabel(strat1);
    $('aivai-strat2').textContent = strategyLabel(strat2);
    $('aivai-score1').textContent = '0';
    $('aivai-score2').textContent = '0';
    $('aivai-log').innerHTML = '';
    this.gameOverShown = false;
    this.lastStateVersion = null;

    // Reset the live nodes-per-move chart for this new session
    ChartMgr.resetHistoryChart();

    // Start fresh game first
    const startRes = await API.post('/start-game', { rows, cols, mode: 'aivai', strategy: `${strat1}_vs_${strat2}` }, { sessionId: this.sessionId });
    if (startRes.state) {
      this._onState(startRes.state);
    }

    try {
      await API.post('/ai-vs-ai', { strat1, strat2, depth, delay, rows, cols }, { sessionId: this.sessionId });
      this.running = true;
      this.startPolling();
      Toast.show('⚔️ AI Battle started!', 'success');
    } catch (e) {
      Toast.show('Failed to start AI vs AI: ' + e.message, 'error');
    }
  },

  async reset() {
    try {
      Modal.hide();
      const res = await API.post('/reset', {}, { sessionId: this.sessionId });
      if (res.state) {
        this._onState(res.state);
      }
      $('aivai-score1').textContent = '0';
      $('aivai-score2').textContent = '0';
      $('aivai-log').innerHTML = '';
      this.running = false;
      this.gameOverShown = false;
      this.lastStateVersion = null;
      this.stopPolling();
    } catch (e) {
      Toast.show('Reset failed', 'error');
    }
  },

  _onState(state) {
    if (!$('section-aivai').classList.contains('active')) return;
    const version = state?.state_version;
    if (version !== undefined && version === this.lastStateVersion) return;
    if (version !== undefined) this.lastStateVersion = version;

    if (!this.board) {
      this.board = new GameBoard('aivai-grid', { readOnly: true });
    }
    this.board.render(state);

    $('aivai-score1').textContent = state.scores[1] ?? state.scores['1'] ?? 0;
    $('aivai-score2').textContent = state.scores[2] ?? state.scores['2'] ?? 0;

    const pill = $('aivai-turn-pill');
    if (pill) {
      const isP1 = state.current_player === 1;
      pill.textContent = isP1 ? 'Agent 1 (Blue)' : 'Agent 2 (Red)';
      pill.className   = `turn-pill ${isP1 ? 'p1' : 'p2'}`;
    }

    if (state.is_game_over && !this.gameOverShown) {
      this.gameOverShown = true;
      const winner = this._winnerFromScores(state.scores);
      Modal.show(state.scores || {}, winner, () => this.start(), 'aivai');
      if (winner !== 0) launchConfetti();
      this.running = false;
      this.stopPolling();
    }
  },

  _onMetrics(data) {
    if (!$('section-aivai').classList.contains('active')) return;

    const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    set('aivai-nodes',  data.nodes ?? '—');
    set('aivai-pruned', data.pruned ?? '—');
    set('aivai-time',   typeof data.time === 'number' ? msOrSec(data.time) : '—');
    set('aivai-qval',   typeof data.q_value === 'number' ? data.q_value.toFixed(3) : '—');

    // Log
    if (data.strategy) {
      const logBox = $('aivai-log');
      if (logBox) {
        // Colour by which agent is currently active (agent-1=blue, agent-2=red)
        const strat1 = $('aivai-strat1-sel')?.value;
        const cls = data.strategy === strat1 ? 'log-p1' : 'log-p2';
        const entry = el('div', `log-entry ${cls}`,
          `${strategyLabel(data.strategy)} | nodes:${data.nodes ?? '?'} | pruned:${data.pruned ?? 0}`);
        logBox.prepend(entry);
        while (logBox.children.length > 40) logBox.lastChild.remove();
      }
    }
  },

  _onGameOver(data) {
    if (!$('section-aivai').classList.contains('active')) return;
    if (this.gameOverShown) return;
    this.gameOverShown = true;
    const scores = data.scores || {};
    const winner = data.winner ?? 0;
    Modal.show(scores, winner, () => this.start(), 'aivai');
    if (winner !== 0) launchConfetti();
    this.running = false;
    this.stopPolling();
  },

  _winnerFromScores(scores) {
    const p1 = scores?.[1] ?? scores?.['1'] ?? 0;
    const p2 = scores?.[2] ?? scores?.['2'] ?? 0;
    if (p1 > p2) return 1;
    if (p2 > p1) return 2;
    return 0;
  },
};

/* ── Algorithm Comparison Controller ─────────────────────────── */
const Comparison = {
  sessionId: getScopedSessionId('comparison'),

  init() {
    $('btn-run-comparison').onclick = () => this.run();
  },

  async run() {
    ChartMgr.activateComparisonView();
    const depth = parseInt($('cmp-depth').value);
    const gridSz = parseInt($('cmp-grid').value);
    const btn = $('btn-run-comparison');
    btn.textContent = '⏳ Running…';
    btn.disabled = true;

    // Optionally start a fresh game at this size for comparison
    try {
      await API.post('/start-game', { rows: gridSz, cols: gridSz, mode: 'hvai', strategy: 'alphabeta' }, { sessionId: this.sessionId });
    } catch {}

    try {
      const res = await API.post('/comparison', { depth }, { sessionId: this.sessionId });

      // Show result cards
      $('cmp-result').style.display = 'grid';
      $('cmp-charts').style.display = 'grid';

      const fmt_move = m => m ? `${m.type.toUpperCase()}(${m.r},${m.c})` : '—';

      $('cmp-mm-nodes').textContent  = res.minimax.nodes;
      $('cmp-mm-time').textContent   = msOrSec(res.minimax.time);
      $('cmp-mm-pruned').textContent = res.minimax.pruned;
      $('cmp-mm-move').textContent   = fmt_move(res.minimax.move);
      $('cmp-mm-score').textContent  = fmt(res.minimax.score, 2);

      $('cmp-ab-nodes').textContent  = res.alphabeta.nodes;
      $('cmp-ab-time').textContent   = msOrSec(res.alphabeta.time);
      $('cmp-ab-pruned').textContent = res.alphabeta.pruned;
      $('cmp-ab-move').textContent   = fmt_move(res.alphabeta.move);
      $('cmp-ab-score').textContent  = fmt(res.alphabeta.score, 2);

      $('saving-pct').textContent = res.pruning_savings_pct + '%';
      $('cmp-speedup').textContent = (res.speedup_factor || '—') + '×';

      ChartMgr.updateComparisonCharts(
        res.minimax.nodes, res.alphabeta.nodes,
        res.minimax.time,  res.alphabeta.time,
      );

      Toast.show(`✅ Comparison done. Alpha-Beta saved ${res.pruning_savings_pct}% nodes!`, 'success', 4000);
    } catch (e) {
      Toast.show('Comparison failed: ' + e.message, 'error');
    } finally {
      btn.textContent = '▶ Run Comparison';
      btn.disabled = false;
    }
  },
};

/* ── Game History ─────────────────────────────────────────────── */
const History = {
  currentReplay: null,
  replayStep:    0,

  async load() {
    try {
      const res  = await API.get('/history');
      const games = res.games || [];
      const tbody = $('history-body');
      const count = $('history-count');
      if (count) count.textContent = `${games.length} game(s) saved`;

      if (!games.length) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:2rem;">
          No games yet — play some games first!
        </td></tr>`;
        return;
      }

      tbody.innerHTML = games.map(g => {
        const winner = g.winner === 0 ? '<span class="badge badge-gray">Draw</span>'
          : g.winner === 1 ? '<span class="badge badge-blue">P1</span>'
          : '<span class="badge badge-red">P2/AI</span>';
        const mode = g.mode === 'hvh' ? '<span class="badge badge-gray">HvH</span>'
          : g.mode === 'hvai' ? '<span class="badge badge-blue">HvAI</span>'
          : '<span class="badge badge-purple">AIvAI</span>';
        const strat = strategyLabel(g.strategy) || g.strategy || '—';
        const date  = g.ended_at ? new Date(g.ended_at + 'Z').toLocaleString() : '—';
        return `<tr>
          <td>${g.id}</td>
          <td>${mode}</td>
          <td><span class="badge badge-gray">${strat}</span></td>
          <td>${g.rows}×${g.cols}</td>
          <td><strong style="color:var(--blue-600);">${g.score_p1}</strong>
            <span style="color:var(--text-light);"> – </span>
            <strong style="color:var(--red-600);">${g.score_p2}</strong></td>
          <td>${winner}</td>
          <td style="font-size:0.78rem;color:var(--text-muted);">${date}</td>
          <td><button class="btn btn-sm btn-outline-blue" onclick="History.replay(${g.id})">↩ Replay</button></td>
        </tr>`;
      }).join('');
    } catch (e) {
      Toast.show('Failed to load history: ' + e.message, 'error');
    }
  },

  async replay(gameId) {
    try {
      const data = await API.get(`/history/${gameId}`);
      this.currentReplay = data;
      this.replayStep    = 0;

      $('replay-game-id').textContent = gameId;
      $('replay-panel').classList.add('visible');

      this._renderReplayStep();
      $('btn-replay-prev').onclick  = () => { this.replayStep = Math.max(0, this.replayStep - 1); this._renderReplayStep(); };
      $('btn-replay-next').onclick  = () => { this.replayStep = Math.min(data.moves.length, this.replayStep + 1); this._renderReplayStep(); };
      $('btn-replay-close').onclick = () => { $('replay-panel').classList.remove('visible'); this.currentReplay = null; };
    } catch (e) {
      Toast.show('Failed to load replay: ' + e.message, 'error');
    }
  },

  _renderReplayStep() {
    if (!this.currentReplay) return;
    const { game, moves } = this.currentReplay;
    const total = moves.length;
    $('replay-step-info').textContent = `${this.replayStep} / ${total}`;

    // Rebuild state up to replayStep
    const state = this._rebuildState(game.rows, game.cols, moves.slice(0, this.replayStep));
    const board = new GameBoard('replay-grid', { readOnly: true });
    board.render(state);

    if (this.replayStep > 0) {
      const m = moves[this.replayStep - 1];
      $('replay-move-info').textContent =
        `Move ${m.move_num}: Player ${m.player} drew ${m.move_type?.toUpperCase() || '?'}(${m.move_r},${m.move_c})`
        + (m.nodes ? ` | nodes: ${m.nodes}` : '')
        + (m.strategy ? ` | strategy: ${strategyLabel(m.strategy)}` : '');
    } else {
      $('replay-move-info').textContent = 'Start of game — press Next to step through moves';
    }
  },

  _rebuildState(rows, cols, moves) {
    const hl = Array.from({length: rows+1}, () => Array(cols  ).fill(false));
    const vl = Array.from({length: rows  }, () => Array(cols+1).fill(false));
    const bx = Array.from({length: rows  }, () => Array(cols  ).fill(0));
    let cur = 1;
    const scores = {1: 0, 2: 0};

    for (const m of moves) {
      const r = m.move_r, c = m.move_c;
      if (m.move_type === 'h') hl[r][c] = true;
      else                     vl[r][c] = true;

      // Check for completed boxes — guard every array access for bounds safety
      let any = false;
      if (m.move_type === 'h') {
        // Box above the drawn h-line
        if (r > 0 && bx[r-1][c] === 0
            && hl[r-1][c] && hl[r][c]
            && vl[r-1][c] && (c+1 <= cols ? vl[r-1][c+1] : false)) {
          bx[r-1][c] = cur; scores[cur]++; any = true;
        }
        // Box below the drawn h-line
        if (r < rows && bx[r][c] === 0
            && hl[r][c] && hl[r+1][c]
            && vl[r][c] && (c+1 <= cols ? vl[r][c+1] : false)) {
          bx[r][c] = cur; scores[cur]++; any = true;
        }
      } else {
        // Box to the left of drawn v-line
        if (c > 0 && bx[r][c-1] === 0
            && vl[r][c-1] && vl[r][c]
            && (r+1 <= rows ? hl[r+1][c-1] : false) && hl[r][c-1]) {
          bx[r][c-1] = cur; scores[cur]++; any = true;
        }
        // Box to the right of drawn v-line
        if (c < cols && bx[r][c] === 0
            && vl[r][c] && (c+1 <= cols ? vl[r][c+1] : false)
            && hl[r][c] && (r+1 <= rows ? hl[r+1][c] : false)) {
          bx[r][c] = cur; scores[cur]++; any = true;
        }
      }
      if (!any) cur = cur === 1 ? 2 : 1;
    }

    return {
      rows, cols,
      horizontal_lines: hl,
      vertical_lines:   vl,
      boxes:            bx,
      current_player:   cur,
      scores,
      is_game_over: false,
    };
  },
};

/* ── Dashboard ─────────────────────────────────────────────────── */
const Dashboard = {
  async load() {
    try {
      const res = await API.get('/stats');
      const db  = res.database || {};

      const set = (id, v) => { const e = $(id); if (e) e.textContent = v ?? '—'; };
      set('stat-total-games', db.total_games || 0);
      const aiWins = db.wins_by_player?.['2'] || 0;
      set('stat-ai-wins', aiWins);
    } catch {}
  },

  quickStart(mode) {
    if (mode === 'hvh' || mode === 'hvai') {
      Nav.go('play-minimax');
      // Set the mode selector
      setTimeout(() => { const sel = $('mm-mode'); if (sel) { sel.value = mode; PlaySections.mm._startGame(); } }, 100);
    } else {
      Nav.go('aivai');
    }
  },
};

/* ── Game Over Modal ──────────────────────────────────────────── */
const Modal = {
  _playAgainCb: null,

  show(scores, winner, playAgainCb, mode = 'hvh') {
    this._playAgainCb = playAgainCb;

    const p1 = scores[1] ?? scores['1'] ?? 0;
    const p2 = scores[2] ?? scores['2'] ?? 0;

    let icon, title;
    if (mode === 'aivai') {
      icon = winner === 0 ? '🤝' : winner === 1 ? '🔵' : '🔴';
      title = winner === 0 ? "It's a Draw!" : winner === 1 ? 'Agent 1 (Blue) Wins!' : 'Agent 2 (Red) Wins!';
    } else if (mode === 'hvai') {
      icon = winner === 0 ? '🤝' : winner === 1 ? '🎉' : '🤖';
      title = winner === 0 ? "It's a Draw!" : winner === 1 ? 'You Win!' : 'AI Wins!';
    } else {
      icon = winner === 0 ? '🤝' : winner === 1 ? '🎉' : '🎊';
      title = winner === 0 ? "It's a Draw!" : winner === 1 ? 'Player 1 Wins!' : 'Player 2 Wins!';
    }

    $('modal-icon').textContent      = icon;
    $('modal-title').textContent     = title;
    $('modal-sub').textContent       = 'Final Score';
    $('modal-p1-score').textContent  = p1;
    $('modal-p2-score').textContent  = p2;

    const modal = $('modal-gameover');
    modal.classList.remove('open');
    void modal.offsetWidth;
    modal.classList.add('open');
  },

  hide() {
    $('modal-gameover').classList.remove('open');
  },

  init() {
    $('btn-modal-again').onclick   = () => { this.hide(); this._playAgainCb?.(); };
    $('btn-modal-history').onclick = () => { this.hide(); Nav.go('history'); };
    $('modal-gameover').addEventListener('click', e => {
      if (e.target === $('modal-gameover')) this.hide();
    });
  },
};

/* ── Play Sections holder ─────────────────────────────────────── */
const PlaySections = {};

/* ── Init ─────────────────────────────────────────────────────── */
const App = {
  quickStart(mode) { Dashboard.quickStart(mode); },

  syncLiveSession(section) {
    if (section === 'play-minimax' && PlaySections.mm) {
      WS.setSession(PlaySections.mm.sessionId);
      PlaySections.mm.stopPolling();
      PlaySections.ab?.stopPolling();
      AiVsAi.stopPolling();
      if (!PlaySections.mm.hasStarted) {
        PlaySections.mm._startGame();
      }
      return;
    }
    if (section === 'play-alphabeta' && PlaySections.ab) {
      WS.setSession(PlaySections.ab.sessionId);
      PlaySections.ab.stopPolling();
      PlaySections.mm?.stopPolling();
      AiVsAi.stopPolling();
      if (!PlaySections.ab.hasStarted) {
        PlaySections.ab._startGame();
      }
      return;
    }
    if (section === 'aivai') {
      WS.setSession(AiVsAi.sessionId);
      AiVsAi.startPolling();
      PlaySections.mm?.stopPolling();
      PlaySections.ab?.stopPolling();
      return;
    }
    PlaySections.mm?.stopPolling();
    PlaySections.ab?.stopPolling();
    AiVsAi.stopPolling();
    WS.setSession(getScopedSessionId('dashboard'));
  },

  init() {
    // Build play sections
    PlaySections.mm = new PlaySection('play-mm-root', 'minimax');
    PlaySections.ab = new PlaySection('play-ab-root', 'alphabeta');

    // AI vs AI
    AiVsAi.init();

    // Comparison
    Comparison.init();

    WS.connect(getScopedSessionId('dashboard'));
    Nav.init();
    Modal.init();
    document.addEventListener('visibilitychange', () => this.handleVisibilityChange());
    window.addEventListener('hashchange', () => {
      const section = location.hash ? location.hash.slice(1) : 'dashboard';
      if (section && section !== Nav.current) Nav.go(section);
    });
    window.addEventListener('resize', () => {
      ChartMgr.nodes?.resize();
      ChartMgr.time?.resize();
      ChartMgr.history?.resize();
      ChartMgr.qvalues?.resize();
    });

    // History
    $('btn-refresh-history').onclick = () => History.load();

    // Dashboard — single load on init
    Dashboard.load();
    const hashSection = location.hash ? location.hash.slice(1) : '';
    const validSections = new Set(['dashboard', 'play-minimax', 'play-alphabeta', 'aivai', 'comparison', 'history']);
    if (validSections.has(hashSection) && hashSection !== Nav.current) {
      Nav.go(hashSection);
    } else {
      this.syncLiveSession(Nav.current);
    }
  },

  handleVisibilityChange() {
    if (document.hidden) {
      PlaySections.mm?.stopPolling();
      PlaySections.ab?.stopPolling();
      AiVsAi.stopPolling();
      return;
    }
    this.syncLiveSession(Nav.current);
    if (Nav.current === 'comparison') {
      ChartMgr.activateComparisonView();
    }
  },
};

/* Start the app once DOM is ready */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => App.init());
} else {
  App.init();
}
