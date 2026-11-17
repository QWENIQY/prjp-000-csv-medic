/* CSV Medic editor — virtualised grid, issue panel, inline editing. */
(() => {
  'use strict';

  const RH = 32; // row height (px) — keep in sync with .cell height in CSS
  const OVERSCAN = 12;
  const AUTO_RECHECK_MAX_ROWS = 20000;
  const MAX_ISSUES_SHOWN = 1000;
  const SEV_RANK = { error: 3, warning: 2, fixed: 1 };

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  const ui = {
    uploadView: $('upload-view'), editorView: $('editor-view'), dropzone: $('dropzone'), fileInput: $('file-input'),
    sampleBtn: $('sample-btn'), uploadError: $('upload-error'), fileName: $('file-name'), search: $('search'),
    issuesOnly: $('issues-only'), undoBtn: $('undo-btn'), addRowBtn: $('add-row-btn'), delRowBtn: $('del-row-btn'),
    recheckBtn: $('recheck-btn'), newFileBtn: $('new-file-btn'), scroll: $('grid-scroll'), header: $('grid-header'),
    body: $('grid-body'), statusRows: $('status-rows'), statusCell: $('status-cell'), groupList: $('group-list'),
    issueList: $('issue-list'), detailsLabel: $('details-label'), downloadBtn: $('download-btn'), downloadNote: $('download-note'),
    loading: $('loading'), loadingText: $('loading-text'), pricingLine: $('pricing-line'),
    counts: { fixed: $('count-fixed'), warning: $('count-warning'), error: $('count-error') },
    chips: document.querySelectorAll('.chip[data-sev]'),
  };

  const state = {
    filename: 'products.csv',
    headers: [],
    rows: [],
    fixedIssues: [], // cumulative fixes (from upload + re-checks)
    problems: [], // warnings + errors from the latest check
    fixedGroups: new Map(),
    problemGroups: [],
    fixedTotal: 0,
    cellSev: new Map(), // "row|col" -> { sev, msg }
    rowSev: new Map(), // row -> highest problem severity
    edited: new Set(),
    view: [], // data-row indexes currently shown
    sel: null, // { row, col }
    sevFilter: null,
    undo: [],
    version: 0,
    checkedVersion: 0,
    exported: false,
    colWidths: [],
    colOffsets: [],
    renderedRange: [-1, -1],
    config: { priceLabel: '£5.00', freePerDay: 1, maxUploadBytes: 15 * 1024 * 1024 },
  };

  /* ------------------------------------------------------------------ */
  /* Config                                                              */
  /* ------------------------------------------------------------------ */
  fetch('/api/config')
    .then((r) => r.json())
    .then((cfg) => {
      state.config = cfg;
      const line = `${cfg.freePerDay} free download${cfg.freePerDay === 1 ? '' : 's'} a day, then ${cfg.priceLabel} per file`;
      ui.pricingLine.textContent = line;
      ui.downloadNote.textContent = line;
    })
    .catch(() => {});

  /* ------------------------------------------------------------------ */
  /* Upload                                                              */
  /* ------------------------------------------------------------------ */
  ui.fileInput.addEventListener('change', () => {
    if (ui.fileInput.files[0]) handleFile(ui.fileInput.files[0]);
    ui.fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach((t) =>
    ui.dropzone.addEventListener(t, (e) => {
      e.preventDefault();
      ui.dropzone.classList.add('dragover');
    }),
  );
  ['dragleave', 'drop'].forEach((t) => ui.dropzone.addEventListener(t, () => ui.dropzone.classList.remove('dragover')));
  ui.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
  // Allow dropping anywhere on the upload screen.
  ui.uploadView.addEventListener('dragover', (e) => e.preventDefault());
  ui.uploadView.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.target === ui.uploadView && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  ui.sampleBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/samples/messy-products.csv');
      const blob = await res.blob();
      handleFile(new File([blob], 'messy-products.csv', { type: 'text/csv' }));
    } catch {
      showUploadError('Could not load the sample file.');
    }
  });

  function showUploadError(msg) {
    ui.uploadError.textContent = msg;
    ui.uploadError.hidden = !msg;
  }

  async function handleFile(file) {
    showUploadError('');
    if (file.size === 0) return showUploadError('That file is empty.');
    if (file.size > state.config.maxUploadBytes) return showUploadError('That file is larger than 15 MB — Shopify\'s import limit. Split it into smaller files and try again.');
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (head[0] === 0x50 && head[1] === 0x4b) return showUploadError('That looks like an Excel (.xlsx) file. In Excel choose File → Save As → "CSV UTF-8 (Comma delimited)", then upload the .csv.');

    setLoading(true, 'Fixing your CSV…');
    try {
      const res = await fetch('/api/fix/upload', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: file });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Upload failed. Please try again.');
      state.filename = file.name || 'products.csv';
      loadResult(data, true);
    } catch (err) {
      showUploadError(err.message);
    } finally {
      setLoading(false);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Results                                                             */
  /* ------------------------------------------------------------------ */
  function loadResult(data, initial) {
    const sameShape = !initial && data.rows.length === state.rows.length;
    state.headers = data.headers;
    state.rows = data.rows;

    const newFixed = data.issues.filter((i) => i.severity === 'fixed');
    if (initial) {
      state.fixedIssues = newFixed;
      state.fixedGroups = new Map();
      state.fixedTotal = 0;
      state.edited = new Set();
      state.undo = [];
      state.sel = null;
      state.exported = false;
      state.version = 0;
    } else {
      if (!sameShape) {
        // Row indexes shifted (e.g. blank rows removed) — old highlights no longer line up.
        state.fixedIssues = state.fixedIssues.filter((i) => i.row == null);
        state.undo = [];
        state.edited = new Set();
      }
      state.fixedIssues = state.fixedIssues.concat(newFixed);
    }
    for (const g of data.summary.byCode) {
      if (g.severity !== 'fixed') continue;
      const prev = state.fixedGroups.get(g.code);
      state.fixedGroups.set(g.code, { ...g, count: (prev ? prev.count : 0) + g.count });
    }
    state.fixedTotal += data.summary.fixed;
    state.problems = data.issues.filter((i) => i.severity !== 'fixed');
    state.problemGroups = data.summary.byCode.filter((g) => g.severity !== 'fixed');
    state.problemCounts = { warning: data.summary.warnings, error: data.summary.errors };
    state.checkedVersion = state.version;

    if (initial) {
      ui.fileName.textContent = state.filename;
      ui.fileName.title = state.filename;
      ui.uploadView.hidden = true;
      ui.editorView.hidden = false;
      setupColumns();
      ui.scroll.scrollTop = 0;
      ui.scroll.scrollLeft = 0;
    } else if (data.headers.length !== state.colWidths.length - 1) {
      setupColumns();
    }
    rebuildSeverity();
    renderSidebar();
    applyFilter();
    updateUndo();
  }

  function rebuildSeverity() {
    const colIdx = new Map(state.headers.map((h, i) => [h, i]));
    state.cellSev = new Map();
    state.rowSev = new Map();
    const add = (iss) => {
      if (iss.row == null) return;
      if (iss.severity !== 'fixed') {
        const cur = state.rowSev.get(iss.row);
        if (!cur || SEV_RANK[iss.severity] > SEV_RANK[cur]) state.rowSev.set(iss.row, iss.severity);
      }
      const ci = colIdx.get(iss.col);
      if (ci === undefined) return;
      const k = iss.row + '|' + ci;
      const cur = state.cellSev.get(k);
      if (!cur || SEV_RANK[iss.severity] >= SEV_RANK[cur.sev]) state.cellSev.set(k, { sev: iss.severity, msg: iss.message });
    };
    state.fixedIssues.forEach(add);
    state.problems.forEach(add);
  }

  /* ------------------------------------------------------------------ */
  /* Sidebar                                                             */
  /* ------------------------------------------------------------------ */
  function renderSidebar() {
    ui.counts.fixed.textContent = state.fixedTotal.toLocaleString('en-GB');
    ui.counts.warning.textContent = state.problemCounts.warning.toLocaleString('en-GB');
    ui.counts.error.textContent = state.problemCounts.error.toLocaleString('en-GB');
    ui.chips.forEach((c) => c.setAttribute('aria-pressed', String(state.sevFilter === c.dataset.sev)));

    const groups = [...state.problemGroups, ...state.fixedGroups.values()].filter((g) => !state.sevFilter || g.severity === state.sevFilter);
    const gFrag = document.createDocumentFragment();
    for (const g of groups) {
      const li = el('li');
      const label = el('span');
      label.append(el('span', `dot ${g.severity === 'error' ? 'red' : g.severity === 'fixed' ? 'green' : 'amber'}`), ' ', g.message);
      li.append(label, el('b', null, g.count.toLocaleString('en-GB')));
      gFrag.append(li);
    }
    if (!groups.length) gFrag.append(el('li', null, state.sevFilter ? 'Nothing here.' : 'No problems found — your file looks great.'));
    ui.groupList.replaceChildren(gFrag);

    const all = [...state.problems, ...state.fixedIssues]
      .filter((i) => !state.sevFilter || i.severity === state.sevFilter)
      .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || (a.row ?? -1) - (b.row ?? -1));
    const frag = document.createDocumentFragment();
    for (const iss of all.slice(0, MAX_ISSUES_SHOWN)) {
      const li = el('li');
      const btn = el('button', `issue ${iss.severity}`);
      btn.type = 'button';
      const loc = iss.row != null ? `Row ${iss.row + 2}${iss.col ? ' · ' + iss.col : ''}` : iss.col ? `Column · ${iss.col}` : 'Whole file';
      btn.append(el('span', 'loc', loc), document.createTextNode(iss.message));
      if (iss.before !== undefined && iss.after !== undefined) {
        const diff = el('span', 'diff');
        diff.append(el('del', null, iss.before === '' ? '(blank)' : iss.before), ' → ', el('ins', null, iss.after === '' ? '(blank)' : iss.after));
        btn.append(diff);
      }
      if (iss.row != null) {
        btn.addEventListener('click', () => goToCell(iss.row, iss.col));
      } else btn.disabled = true;
      li.append(btn);
      frag.append(li);
    }
    ui.issueList.replaceChildren(frag);
    ui.detailsLabel.textContent = all.length > MAX_ISSUES_SHOWN ? `Showing first ${MAX_ISSUES_SHOWN.toLocaleString('en-GB')} of ${all.length.toLocaleString('en-GB')}` : 'All changes & issues';
  }

  ui.chips.forEach((chip) =>
    chip.addEventListener('click', () => {
      state.sevFilter = state.sevFilter === chip.dataset.sev ? null : chip.dataset.sev;
      renderSidebar();
    }),
  );

  /* ------------------------------------------------------------------ */
  /* Grid                                                                */
  /* ------------------------------------------------------------------ */
  function widthFor(h) {
    if (h === 'Body (HTML)') return 320;
    if (h === 'Image Src' || h === 'Variant Image') return 280;
    if (h === 'Title' || h === 'SEO Description') return 240;
    if (h === 'Handle' || h === 'Tags' || h === 'SEO Title' || h === 'Image Alt Text' || h === 'Product Category') return 200;
    return Math.max(110, Math.min(200, h.length * 8 + 24));
  }

  function setupColumns() {
    const rownumW = Math.max(56, String(state.rows.length + 1).length * 9 + 24);
    state.colWidths = [rownumW, ...state.headers.map(widthFor)];
    state.colOffsets = [];
    let x = 0;
    for (const w of state.colWidths) {
      state.colOffsets.push(x);
      x += w;
    }
    ui.scroll.style.setProperty('--cols', state.colWidths.map((w) => w + 'px').join(' '));
    const frag = document.createDocumentFragment();
    frag.append(el('div', 'cell rownum', '#'));
    state.headers.forEach((h) => {
      const c = el('div', 'cell', h);
      c.title = h;
      c.setAttribute('role', 'columnheader');
      frag.append(c);
    });
    ui.header.replaceChildren(frag);
  }

  function applyFilter() {
    const q = ui.search.value.trim().toLowerCase();
    const onlyIssues = ui.issuesOnly.checked;
    if (!q && !onlyIssues) {
      state.view = state.rows.map((_, i) => i);
    } else {
      state.view = [];
      for (let i = 0; i < state.rows.length; i++) {
        if (onlyIssues && !state.rowSev.has(i)) continue;
        if (q && !state.rows[i].some((c) => c.toLowerCase().includes(q))) continue;
        state.view.push(i);
      }
    }
    ui.body.style.height = state.view.length * RH + 'px';
    const total = state.rows.length.toLocaleString('en-GB');
    ui.statusRows.textContent = state.view.length === state.rows.length ? `${total} rows` : `${state.view.length.toLocaleString('en-GB')} of ${total} rows`;
    render(true);
  }

  let searchTimer;
  ui.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applyFilter, 150);
  });
  ui.issuesOnly.addEventListener('change', applyFilter);

  let rafPending = false;
  ui.scroll.addEventListener(
    'scroll',
    () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        render(false);
      });
    },
    { passive: true },
  );
  window.addEventListener('resize', () => render(true));

  function render(force) {
    const top = ui.scroll.scrollTop;
    const h = ui.scroll.clientHeight;
    const start = Math.max(0, Math.floor(top / RH) - OVERSCAN);
    const end = Math.min(state.view.length, Math.ceil((top + h) / RH) + OVERSCAN);
    if (!force && start === state.renderedRange[0] && end === state.renderedRange[1]) return;
    state.renderedRange = [start, end];

    const frag = document.createDocumentFragment();
    for (let v = start; v < end; v++) {
      const ri = state.view[v];
      const row = state.rows[ri];
      const rowEl = el('div', 'grid-row');
      rowEl.style.top = v * RH + 'px';
      rowEl.dataset.row = ri;
      rowEl.setAttribute('role', 'row');
      const num = el('div', 'cell rownum', String(ri + 2));
      rowEl.append(num);
      for (let ci = 0; ci < state.headers.length; ci++) {
        const val = row[ci] ?? '';
        const c = el('div', 'cell');
        c.dataset.col = ci;
        c.setAttribute('role', 'gridcell');
        if (val === '') c.classList.add('empty');
        else c.textContent = val.length > 300 ? val.slice(0, 300) + '…' : val;
        const sev = state.cellSev.get(ri + '|' + ci);
        if (sev) {
          c.classList.add('sev-' + sev.sev);
          c.title = sev.msg;
        }
        if (state.edited.has(ri + '|' + ci)) c.classList.add('edited');
        if (state.sel && state.sel.row === ri && state.sel.col === ci) c.classList.add('selected');
        rowEl.append(c);
      }
      frag.append(rowEl);
    }
    ui.body.replaceChildren(frag);
  }

  function cellEl(row, col) {
    const r = ui.body.querySelector(`.grid-row[data-row="${row}"]`);
    return r ? r.children[col + 1] : null;
  }

  function select(row, col, { scroll = true } = {}) {
    if (row == null || col == null) return;
    const prev = state.sel && cellEl(state.sel.row, state.sel.col);
    if (prev) prev.classList.remove('selected');
    state.sel = { row, col };
    if (scroll) scrollToCell(row, col);
    const c = cellEl(row, col);
    if (c) c.classList.add('selected');
    const sev = state.cellSev.get(row + '|' + col);
    ui.statusCell.textContent = `Row ${row + 2} · ${state.headers[col]}${sev && sev.sev !== 'fixed' ? ' — ' + sev.msg : ''}`;
  }

  function scrollToCell(row, col, center = false) {
    const v = state.view.indexOf(row);
    if (v === -1) return;
    const s = ui.scroll;
    const headerH = ui.header.offsetHeight;
    const y = v * RH;
    if (center) s.scrollTop = Math.max(0, y - (s.clientHeight - headerH) / 2);
    else if (y < s.scrollTop) s.scrollTop = y;
    else if (y + RH > s.scrollTop + s.clientHeight - headerH) s.scrollTop = y + RH - s.clientHeight + headerH;
    const x = state.colOffsets[col + 1];
    const w = state.colWidths[col + 1];
    const stickyW = state.colWidths[0];
    if (x - stickyW < s.scrollLeft) s.scrollLeft = x - stickyW;
    else if (x + w > s.scrollLeft + s.clientWidth) s.scrollLeft = x + w - s.clientWidth;
    render(false);
  }

  function goToCell(row, colName) {
    if (row >= state.rows.length) return;
    let col = state.headers.indexOf(colName);
    if (col === -1) col = 0;
    if (state.view.indexOf(row) === -1) {
      ui.search.value = '';
      ui.issuesOnly.checked = false;
      applyFilter();
    }
    scrollToCell(row, col, true);
    render(true);
    select(row, col, { scroll: false });
    const c = cellEl(row, col);
    if (c) {
      c.classList.remove('flash');
      void c.offsetWidth;
      c.classList.add('flash');
    }
    ui.scroll.focus({ preventScroll: true });
  }

  ui.body.addEventListener('click', (e) => {
    const c = e.target.closest('.cell');
    if (!c || c.classList.contains('rownum')) return;
    select(Number(c.parentElement.dataset.row), Number(c.dataset.col), { scroll: false });
    ui.scroll.focus({ preventScroll: true });
  });
  ui.body.addEventListener('dblclick', (e) => {
    const c = e.target.closest('.cell');
    if (!c || c.classList.contains('rownum')) return;
    select(Number(c.parentElement.dataset.row), Number(c.dataset.col), { scroll: false });
    startEdit();
  });

  ui.scroll.addEventListener('keydown', (e) => {
    if (e.target !== ui.scroll) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      doUndo();
      return;
    }
    if (!state.sel) {
      if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key) && state.view.length) {
        e.preventDefault();
        select(state.view[0], 0);
      }
      return;
    }
    const { row, col } = state.sel;
    const v = state.view.indexOf(row);
    const move = (dv, dc) => {
      const nv = Math.max(0, Math.min(state.view.length - 1, v + dv));
      const nc = Math.max(0, Math.min(state.headers.length - 1, col + dc));
      if (state.view.length) select(state.view[nv], nc);
    };
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(1, 0); break;
      case 'ArrowUp': e.preventDefault(); move(-1, 0); break;
      case 'ArrowLeft': e.preventDefault(); move(0, -1); break;
      case 'ArrowRight': e.preventDefault(); move(0, 1); break;
      case 'Tab': e.preventDefault(); move(0, e.shiftKey ? -1 : 1); break;
      case 'PageDown': e.preventDefault(); move(Math.floor(ui.scroll.clientHeight / RH) - 1, 0); break;
      case 'PageUp': e.preventDefault(); move(-Math.floor(ui.scroll.clientHeight / RH) + 1, 0); break;
      case 'Enter':
      case 'F2': e.preventDefault(); startEdit(); break;
      case 'Delete':
      case 'Backspace': e.preventDefault(); commitValue(row, col, ''); break;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          startEdit(e.key);
        }
    }
  });

  /* ------------------------------------------------------------------ */
  /* Editing                                                             */
  /* ------------------------------------------------------------------ */
  let editor = null;

  function startEdit(initialText) {
    if (!state.sel || editor) return;
    const { row, col } = state.sel;
    scrollToCell(row, col);
    const v = state.view.indexOf(row);
    if (v === -1) return;
    const ta = el('textarea', 'cell-editor');
    ta.setAttribute('aria-label', `Edit ${state.headers[col]}, row ${row + 2}`);
    ta.spellcheck = state.headers[col] === 'Body (HTML)' || state.headers[col] === 'Title';
    ta.value = initialText != null ? initialText : state.rows[row][col] ?? '';
    const big = state.headers[col] === 'Body (HTML)' || ta.value.length > 60;
    ta.style.left = state.colOffsets[col + 1] + 'px';
    ta.style.top = ui.header.offsetHeight + v * RH + 'px';
    ta.style.width = Math.max(state.colWidths[col + 1], big ? 420 : 200) + 'px';
    ta.style.height = (big ? 160 : RH) + 'px';
    ui.scroll.append(ta);
    editor = { ta, row, col };
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        endEdit(false);
      } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        endEdit(true);
        moveAfterEdit(1, 0);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        endEdit(true);
        moveAfterEdit(0, e.shiftKey ? -1 : 1);
      }
    });
    ta.addEventListener('blur', () => endEdit(true));
  }

  function moveAfterEdit(dv, dc) {
    if (!state.sel) return;
    const v = state.view.indexOf(state.sel.row);
    const nv = Math.max(0, Math.min(state.view.length - 1, v + dv));
    const nc = Math.max(0, Math.min(state.headers.length - 1, state.sel.col + dc));
    select(state.view[nv], nc);
  }

  function endEdit(commit) {
    if (!editor) return;
    const { ta, row, col } = editor;
    editor = null;
    const value = ta.value;
    ta.remove();
    if (commit) commitValue(row, col, value);
    ui.scroll.focus({ preventScroll: true });
  }

  function commitValue(row, col, value) {
    const before = state.rows[row][col] ?? '';
    if (before === value) return;
    state.rows[row][col] = value;
    state.undo.push({ type: 'edit', row, col, before, after: value });
    state.edited.add(row + '|' + col);
    changed();
  }

  function changed() {
    state.version++;
    state.exported = false;
    updateUndo();
    render(true);
    scheduleRecheck();
  }

  function updateUndo() {
    ui.undoBtn.disabled = state.undo.length === 0;
  }

  function doUndo() {
    const op = state.undo.pop();
    if (!op) return;
    if (op.type === 'edit') {
      if (state.rows[op.row]) state.rows[op.row][op.col] = op.before;
      select(op.row, op.col);
    } else if (op.type === 'delete') {
      state.rows.splice(op.index, 0, op.row);
      shiftIndexes(op.index, +1);
      applyFilter();
      select(op.index, state.sel ? state.sel.col : 0);
    } else if (op.type === 'insert') {
      state.rows.splice(op.index, 1);
      shiftIndexes(op.index, -1);
      applyFilter();
    }
    state.version++;
    updateUndo();
    render(true);
    scheduleRecheck();
  }

  /** Keep issue/edit row numbers in step when rows are inserted (+1) or deleted (-1). */
  function shiftIndexes(at, delta) {
    const fix = (list) =>
      list
        .filter((i) => !(delta < 0 && i.row === at))
        .map((i) => (i.row != null && i.row >= (delta > 0 ? at : at + 1) ? { ...i, row: i.row + delta } : i));
    state.fixedIssues = fix(state.fixedIssues);
    state.problems = fix(state.problems);
    const edited = new Set();
    for (const k of state.edited) {
      const [r, c] = k.split('|').map(Number);
      if (delta < 0 && r === at) continue;
      edited.add((r >= (delta > 0 ? at : at + 1) ? r + delta : r) + '|' + c);
    }
    state.edited = edited;
    state.undo = state.undo.map((op) => (op.type === 'edit' && op.row >= (delta > 0 ? at : at + 1) ? { ...op, row: op.row + delta } : op));
    rebuildSeverity();
  }

  ui.undoBtn.addEventListener('click', doUndo);

  ui.addRowBtn.addEventListener('click', () => {
    const at = state.sel ? state.sel.row + 1 : state.rows.length;
    const newRow = state.headers.map(() => '');
    // Pre-fill the handle so a new row is treated as a variant of the selected product.
    const hi = state.headers.indexOf('Handle');
    if (state.sel && hi !== -1) newRow[hi] = state.rows[state.sel.row][hi] || '';
    state.rows.splice(at, 0, newRow);
    shiftIndexes(at, +1);
    state.undo.push({ type: 'insert', index: at });
    applyFilter();
    select(at, state.sel ? state.sel.col : 0);
    changed();
    toast('Row added. Double-click a cell to fill it in.');
  });

  ui.delRowBtn.addEventListener('click', () => {
    if (!state.sel) return toast('Select a cell in the row you want to delete first.');
    const at = state.sel.row;
    const [removed] = state.rows.splice(at, 1);
    state.undo.push({ type: 'delete', index: at, row: removed });
    shiftIndexes(at, -1);
    state.sel = null;
    applyFilter();
    changed();
    toast(`Row ${at + 2} deleted. Press Undo to restore it.`);
  });

  /* ------------------------------------------------------------------ */
  /* Re-check                                                            */
  /* ------------------------------------------------------------------ */
  let recheckTimer;
  function scheduleRecheck() {
    clearTimeout(recheckTimer);
    if (state.rows.length > AUTO_RECHECK_MAX_ROWS) {
      ui.recheckBtn.textContent = 'Re-check •';
      return;
    }
    recheckTimer = setTimeout(() => recheck(false), 1200);
  }

  async function recheck(manual) {
    clearTimeout(recheckTimer);
    if (editor) return scheduleRecheck();
    const version = state.version;
    if (manual) setLoading(true, 'Re-checking…');
    try {
      const res = await fetch('/api/fix/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headers: state.headers, rows: state.rows }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Re-check failed.');
      if (version !== state.version || editor) return; // user kept editing — a newer check is scheduled
      const sel = state.sel;
      const top = ui.scroll.scrollTop;
      loadResult(data, false);
      ui.scroll.scrollTop = top;
      if (sel && sel.row < state.rows.length) select(sel.row, sel.col, { scroll: false });
      ui.recheckBtn.textContent = 'Re-check';
      if (manual) toast(data.summary.errors ? `${data.summary.errors} issue(s) still need you.` : 'All clear — no errors left.');
    } catch (err) {
      if (manual) toast(err.message);
    } finally {
      if (manual) setLoading(false);
    }
  }
  ui.recheckBtn.addEventListener('click', () => recheck(true));

  /* ------------------------------------------------------------------ */
  /* Download                                                            */
  /* ------------------------------------------------------------------ */
  ui.downloadBtn.addEventListener('click', async () => {
    if (editor) endEdit(true);
    if (state.version !== state.checkedVersion) await recheck(false);
    const errors = state.problemCounts.error;
    if (errors > 0 && !window.confirm(`${errors} issue(s) still need your attention and Shopify may reject those rows.\n\nContinue to download anyway?`)) return;
    setLoading(true, 'Preparing your file…');
    try {
      const res = await fetch('/api/exports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: state.filename, headers: state.headers, rows: state.rows, fixedCount: state.fixedTotal }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not prepare the download.');
      state.exported = true;
      window.location.href = data.url;
    } catch (err) {
      setLoading(false);
      toast(err.message);
    }
  });

  ui.newFileBtn.addEventListener('click', () => {
    if (!state.exported && state.version > 0 && !window.confirm('Discard your edits and start with a new file?')) return;
    state.rows = [];
    state.headers = [];
    state.sevFilter = null;
    state.version = 0;
    clearTimeout(recheckTimer);
    ui.search.value = '';
    ui.issuesOnly.checked = false;
    ui.editorView.hidden = true;
    ui.uploadView.hidden = false;
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.rows.length && !state.exported && state.version > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /* ------------------------------------------------------------------ */
  /* UI helpers                                                          */
  /* ------------------------------------------------------------------ */
  function setLoading(on, text) {
    if (text) ui.loadingText.textContent = text;
    ui.loading.hidden = !on;
  }

  let toastTimer;
  function toast(msg) {
    let t = document.querySelector('.toast');
    if (!t) {
      t = el('div', 'toast');
      t.setAttribute('role', 'status');
      document.body.append(t);
    }
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }
})();
