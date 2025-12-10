// public/app.js
const tableHead = document.querySelector('#riskTable thead');
const tableBody = document.querySelector('#riskTable tbody');
const summary = document.querySelector('#summary');
const refreshBtn = document.querySelector('#refreshBtn');
const exportCsvBtn = document.querySelector('#exportCsvBtn');
const allPagesEl = document.querySelector('#allPages');
const maxPagesEl = document.querySelector('#maxPages');
const maxRecordsEl = document.querySelector('#maxRecords');
const sortKeyEl = document.querySelector('#sortKey');
const sortDirEl = document.querySelector('#sortDir');
const filterKeyEl = document.querySelector('#filterKey');
const filterValEl = document.querySelector('#filterVal');
const cfColumnsEl = document.querySelector('#cfColumns');
const apiTokenInput = document.querySelector('#apiTokenInput');

let currentData = [];
let availableCFKeys = [];

// localStorage keys
const LS = {
  selectedCFs: 'riskDashboard.selectedCFs',
  sortKey:     'riskDashboard.sortKey',
  sortDir:     'riskDashboard.sortDir',
  filterKey:   'riskDashboard.filterKey',
  filterVal:   'riskDashboard.filterVal',
  apiToken:    'riskDashboard.apiToken',
};

// --- Multi-select UX: click-to-toggle ---
function enableSimpleMultiSelect(el) {
  el.addEventListener('mousedown', (e) => {
    const option = e.target;
    if (option.tagName !== 'OPTION') return;
    e.preventDefault();
    option.selected = !option.selected;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
enableSimpleMultiSelect(cfColumnsEl);

// --- Persistence helpers ---
const saveLS = (k, v) => localStorage.setItem(k, v);
const loadLS = (k, fallback = '') => localStorage.getItem(k) ?? fallback;

function saveSelectedCFColumns() {
  const vals = getSelectedCFColumns();
  saveLS(LS.selectedCFs, JSON.stringify(vals));
}
function loadSelectedCFColumns() {
  try { return JSON.parse(loadLS(LS.selectedCFs, '[]')); } catch { return []; }
}

function persistControls() {
  saveLS(LS.sortKey, sortKeyEl.value);
  saveLS(LS.sortDir, sortDirEl.value);
  saveLS(LS.filterKey, filterKeyEl.value);
  saveLS(LS.filterVal, filterValEl.value);
}

function restoreControls() {
  const sk = loadLS(LS.sortKey, '');
  const sd = loadLS(LS.sortDir, 'asc');
  const fk = loadLS(LS.filterKey, '');
  const fv = loadLS(LS.filterVal, '');

  sortKeyEl.value = sk;
  sortDirEl.value = sd;
  filterKeyEl.value = fk;
  filterValEl.value = fv;

  // restore token into input (kept local in browser)
  apiTokenInput.value = loadLS(LS.apiToken, '');
}

// --- Events ---
refreshBtn.addEventListener('click', load);
exportCsvBtn.addEventListener('click', exportCurrentTableToCsv);

filterValEl.addEventListener('input', () => { persistControls(); render(); });
sortKeyEl.addEventListener('change', () => { persistControls(); render(); });
sortDirEl.addEventListener('change', () => { persistControls(); render(); });
filterKeyEl.addEventListener('change', () => { persistControls(); render(); });

cfColumnsEl.addEventListener('change', () => {
  saveSelectedCFColumns();
  render();
});

apiTokenInput.addEventListener('input', () => {
  saveLS(LS.apiToken, apiTokenInput.value.trim());
});

// --- Utils ---
function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString(); } catch { return String(d); }
}
function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
function hasValue(v) {
  return v !== undefined && v !== null && String(v).trim() !== '';
}

// --- Controls population ---
function populateControls({ customKeys = [] }) {
  const baseOpts = [
    { v: '', t: '—' },
    { v: '__title', t: 'Title' },
    { v: '__status', t: 'Status' },
    { v: '__severity', t: 'Severity' },
  ];
  sortKeyEl.innerHTML = baseOpts
    .concat(customKeys.map(k => ({ v: k, t: `CF: ${k}` })))
    .map(o => `<option value="${escapeHtml(o.v)}">${escapeHtml(o.t)}</option>`)
    .join('');

  filterKeyEl.innerHTML = ['<option value="">—</option>']
    .concat(customKeys.map(k => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`))
    .join('');

  cfColumnsEl.innerHTML = customKeys
    .map(k => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`)
    .join('');
  cfColumnsEl.size = Math.min(customKeys.length || 1, 10);

  // restore selected CFs
  const saved = loadSelectedCFColumns();
  for (const opt of cfColumnsEl.options) {
    if (saved.includes(opt.value)) opt.selected = true;
  }

  // restore sort/filter values *after* options exist
  restoreControls();
}

// --- Sorting / Filtering helpers ---
function getValuesForSortKey(r, key) {
  if (!key)                return { a: r.title,    type: 'string' };
  if (key === '__title')   return { a: r.title,    type: 'string' };
  if (key === '__status')  return { a: r.status,   type: 'string' };
  if (key === '__severity')return { a: r.severity, type: 'string' };

  const entry = (r.cfMap || {})[key]; // { raw, num }
  if (!entry) return { a: undefined, type: 'missing' };
  if (entry.num !== null && entry.num !== undefined) return { a: entry.num, type: 'number' };
  return { a: entry.raw, type: 'string' };
}

function applySortAndFilter(data) {
  const fKey = filterKeyEl.value || '';
  const fVal = (filterValEl.value || '').toLowerCase();

  let rows = data;
  if (fKey && fVal) {
    rows = rows.filter(r => {
      const e = (r.cfMap || {})[fKey];
      if (!e) return false;
      const raw = e.raw != null ? String(e.raw).toLowerCase() : '';
      return raw.includes(fVal);
    });
  }

  const sKey = sortKeyEl.value;
  const dir = sortDirEl.value === 'desc' ? -1 : 1;

  if (sKey) {
    rows = [...rows].sort((a, b) => {
      const A = getValuesForSortKey(a, sKey);
      const B = getValuesForSortKey(b, sKey);

      const aHas = hasValue(A.a);
      const bHas = hasValue(B.a);
      if (aHas && !bHas) return -1;
      if (!aHas && bHas) return 1;
      if (!aHas && !bHas) return 0;

      if (A.type === 'number' && B.type === 'number') return (A.a - B.a) * dir;

      const da = Date.parse(A.a); const db = Date.parse(B.a);
      if (!Number.isNaN(da) && !Number.isNaN(db)) return (da - db) * dir;

      return String(A.a).localeCompare(String(B.a)) * dir;
    });
  }

  return rows;
}

// --- Column selection & rendering ---
function getSelectedCFColumns() {
  return Array.from(cfColumnsEl.selectedOptions).map(o => o.value);
}

function buildHeader(selectedCFs) {
  const headers = [
    '<th>Title</th>',
    '<th>Status</th>',
    '<th>Severity</th>',
  ];
  for (const k of selectedCFs) headers.push(`<th>${escapeHtml(k)}</th>`);
  tableHead.innerHTML = `<tr>${headers.join('')}</tr>`;
}

function render() {
  const rows = applySortAndFilter(currentData);
  const selectedCFs = getSelectedCFColumns();
  buildHeader(selectedCFs);

  tableBody.innerHTML = '';
  for (const r of rows) {
    const cells = [
      `<td><strong>${escapeHtml(r.title)}</strong><div class="muted">ID: ${escapeHtml(String(r.id ?? '—'))}</div></td>`,
      `<td><span class="tag">${escapeHtml(String(r.status))}</span></td>`,
      `<td>${escapeHtml(String(r.severity))}</td>`,
    ];

    for (const key of selectedCFs) {
      const entry = (r.cfMap || {})[key];
      const val = entry ? (entry.raw ?? '—') : '—';
      cells.push(`<td>${escapeHtml(String(val))}</td>`);
    }

    const tr = document.createElement('tr');
    tr.innerHTML = cells.join('');
    tableBody.appendChild(tr);
  }
}

// --- CSV export of current view ---
function csvEscape(val) {
  const s = val == null ? '' : String(val);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function exportCurrentTableToCsv() {
  const selectedCFs = getSelectedCFColumns();
  const headers = ['Title', 'Status', 'Severity', ...selectedCFs];
  const rows = applySortAndFilter(currentData);

  const lines = [];
  lines.push(headers.map(csvEscape).join(','));

  for (const r of rows) {
    const row = [
      r.title ?? '',
      r.status ?? '',
      r.severity ?? '',
      ...selectedCFs.map(k => {
        const entry = (r.cfMap || {})[k];
        return entry ? (entry.raw ?? '') : '';
      })
    ];
    lines.push(row.map(csvEscape).join(','));
  }

  const csv = lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = URL.createObjectURL(blob);
  a.download = `risks_${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(a.href);
  a.remove();
}

// --- Data load ---
async function load() {
  summary.textContent = 'Loading…';
  tableBody.innerHTML = '';

  const token = apiTokenInput.value.trim();
  if (!token) {
    summary.textContent = 'Paste an API token first.';
    return;
  }

  try {
    const params = new URLSearchParams();
    if (allPagesEl.checked) params.set('all', '1');
    const mp = maxPagesEl.value.trim();
    const mr = maxRecordsEl.value.trim();
    if (mp) params.set('maxPages', mp);
    if (mr) params.set('maxRecords', mr);

    const resp = await fetch(`/api/risks?${params.toString()}`, {
      headers: { 'X-Drata-Token': token }
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to load risks (${resp.status}): ${text}`);
    }
    const data = await resp.json();

    currentData = data.risks || [];
    availableCFKeys = data.customFieldKeys || [];

    populateControls({ customKeys: availableCFKeys });
    render();

    summary.textContent =
      `${data.count} risks from register ${data.riskRegisterId} • Pages: ${data.pages} • ` +
      `Fetched ${new Date(data.fetchedAt).toLocaleString()}`;
  } catch (err) {
    console.error(err);
    summary.textContent = `Error: ${err.message}`;
  }
}

// Initialize token + controls from LS even before first load
apiTokenInput.value = loadLS(LS.apiToken, '');
restoreControls();