// server.js
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

function buildRisksUrl({ base, riskRegisterId, qs = {} }) {
  const u = new URL(`${base}/risk-registers/${encodeURIComponent(riskRegisterId)}/risks`);
  u.searchParams.append('expand[]', 'customFields'); // Drata v2 expand array param
  for (const [k, v] of Object.entries(qs)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  }
  return u.toString();
}

async function fetchJson(url, token) {
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    const err = new Error(`Upstream error ${resp.status}`);
    err.status = resp.status;
    err.body = body;
    throw err;
  }
  return resp.json();
}

function parseNumberLike(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/^\(|\)$/g, '').replace(/[%$,]/g, '').replace(/\s+/g, '');
  const n = Number(cleaned);
  if (Number.isNaN(n)) return null;
  return neg ? -n : n;
}

function deriveCustomFieldMap(cfArray = []) {
  const map = {}; // key -> { raw, num }
  for (const item of cfArray) {
    if (!item || typeof item !== 'object') continue;
    const id = item.id || item.customFieldId || item.fieldId || item.uuid;
    const label = item.name || item.label || item.fieldName || item.key || (id ? `cf:${id}` : null);

    let value = item.value ?? item.displayValue ?? null;
    if (value == null) {
      for (const [k, v] of Object.entries(item)) {
        const t = typeof v;
        if (t === 'string' || t === 'number' || t === 'boolean') { value = v; break; }
      }
    }
    const num = parseNumberLike(value);

    if (label) map[String(label)] = { raw: value, num };
    if (id) {
      const idKey = `cf:${id}`;
      if (!(idKey in map)) map[idKey] = { raw: value, num };
    }
  }
  return map;
}

/**
 * GET /api/risks
 * Accepts token from:
 *  - Header: X-Drata-Token (preferred, from UI)
 *  - Env: DRATA_API_TOKEN (fallback)
 *
 * Query:
 *  - all=1          fetch all pages via cursor
 *  - size           page size (1..50)
 *  - maxPages       safety cap (default 200)
 *  - maxRecords     safety cap (default 20000)
 */
app.get('/api/risks', async (req, res) => {
  try {
    const headerToken = req.header('X-Drata-Token');
    const token = headerToken || process.env.DRATA_API_TOKEN;
    const riskRegisterId = process.env.RISK_REGISTER_ID;
    const base = process.env.DRATA_API_BASE || 'https://public-api.drata.com/public/v2';

    if (!token) {
      return res.status(400).json({ error: 'Missing API token. Provide X-Drata-Token header or DRATA_API_TOKEN env.' });
    }
    if (!riskRegisterId) {
      return res.status(500).json({ error: 'Missing RISK_REGISTER_ID in environment.' });
    }

    const fetchAll = String(req.query.all || '') === '1';
    const size = req.query.size;
    const maxPages = Number(req.query.maxPages ?? 200);
    const maxRecords = Number(req.query.maxRecords ?? 20000);

    let cursor;
    let pages = 0;
    let risks = [];

    do {
      const url = buildRisksUrl({ base, riskRegisterId, qs: { cursor, size } });
      const data = await fetchJson(url, token);

      const pageRisks = Array.isArray(data?.data) ? data.data : [];
      risks.push(...pageRisks);
      pages += 1;

      cursor = data?.pagination?.cursor || null;

      if (!fetchAll) break;
      if (!cursor) break;
      if (pages >= maxPages || risks.length >= maxRecords) break;
    } while (true);

    const normalized = risks.map(r => {
      const cfMap = deriveCustomFieldMap(Array.isArray(r.customFields) ? r.customFields : []);
      return {
        id: r.id ?? r.uuid ?? r.riskId ?? null,
        title: r.title ?? r.currentVersionTitle ?? r.name ?? '—',
        status: r.status ?? '—',
        severity: r.severity ?? r.riskLevel ?? r.score ?? '—',
        owner: r.owner?.email || r.owner?.name || r.owner || r.assignee || '—',
        dueDate: r.anticipatedCompletionDate ?? r.dueDate ?? r.targetDate ?? null,
        createdAt: r.createdAt ?? null,
        updatedAt: r.updatedAt ?? null,
        customFields: Array.isArray(r.customFields) ? r.customFields : [],
        cfMap,
        raw: r,
      };
    });

    const customFieldKeys = Array.from(
      normalized.reduce((set, r) => {
        Object.keys(r.cfMap || {}).forEach(k => set.add(k));
        return set;
      }, new Set())
    ).sort((a, b) => a.localeCompare(b));

    res.json({
      count: normalized.length,
      riskRegisterId,
      fetchedAt: new Date().toISOString(),
      pages,
      customFieldKeys,
      risks: normalized,
    });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({
      error: 'Server error',
      details: String(err?.message || err),
      body: err.body,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Risk dashboard listening on http://localhost:${PORT}`);
});