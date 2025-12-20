import { Elysia, t } from "elysia";
import { env } from "@/config/env";
import { getClient } from "@/database";
import { authService } from "@/modules/auth";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function isDbAdminEnabled(): boolean {
  const explicit = (process.env.DB_ADMIN_ENABLED || "").toLowerCase();
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  return env.isDev;
}

function getDbAdminToken(): string | null {
  const token = process.env.DB_ADMIN_TOKEN?.trim();
  return token ? token : null;
}

function isWriteAllowed(): boolean {
  return (process.env.DB_ADMIN_ALLOW_WRITE || "").toLowerCase() === "true";
}

function isValidIdentifier(value: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(value);
}

function qualifyQueryWithKeyspace(query: string, keyspace: string): string {
  const keyspaceQuoted = `"${keyspace}"`;

  const patterns: Array<{
    re: RegExp;
    replace: (tableRef: string) => string;
  }> = [
    {
      re: /\bfrom\s+((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)/i,
      replace: (tableRef) => `FROM ${keyspaceQuoted}.${tableRef}`,
    },
    {
      re: /\binsert\s+into\s+((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)/i,
      replace: (tableRef) => `INSERT INTO ${keyspaceQuoted}.${tableRef}`,
    },
    {
      re: /\bupdate\s+((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)/i,
      replace: (tableRef) => `UPDATE ${keyspaceQuoted}.${tableRef}`,
    },
    {
      re: /\bdelete\s+from\s+((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)/i,
      replace: (tableRef) => `DELETE FROM ${keyspaceQuoted}.${tableRef}`,
    },
  ];

  for (const pattern of patterns) {
    const match = query.match(pattern.re);
    if (!match) continue;
    const tableRef = match[1] || "";
    if (!tableRef) continue;
    if (tableRef.includes(".")) return query;
    return query.replace(pattern.re, () => pattern.replace(tableRef));
  }

  return query;
}

function toJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && !Number.isFinite(value))
    return String(value);

  if (Array.isArray(value)) return value.map(toJsonValue);

  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) {
      obj[String(k)] = toJsonValue(v);
    }
    return obj;
  }

  if (typeof value === "object") {
    const objValue = value as { toString?: () => string };
    if (typeof objValue.toString === "function") {
      const tag = Object.prototype.toString.call(value);
      // Common Cassandra driver types (Uuid/TimeUuid/Long/Inet/etc) stringify nicely.
      if (tag !== "[object Object]") return objValue.toString();
    }

    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "function") continue;
      obj[k] = toJsonValue(v);
    }
    return obj;
  }

  return value;
}

function rowToJson(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object") return {};

  const anyRow = row as {
    keys?: () => string[];
    get?: (key: string) => unknown;
    [key: string]: unknown;
  };

  if (typeof anyRow.keys === "function" && typeof anyRow.get === "function") {
    const obj: Record<string, unknown> = {};
    for (const key of anyRow.keys()) {
      obj[key] = toJsonValue(anyRow.get(key));
    }
    return obj;
  }

  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(anyRow)) {
    if (typeof v === "function") continue;
    obj[k] = toJsonValue(v);
  }
  return obj;
}

async function requireDbAdminAccess(ctx: {
  headers: Record<string, string | undefined>;
  cookie: Record<string, { value?: unknown } | undefined>;
  set: { status?: number | string };
}): Promise<boolean> {
  if (!isDbAdminEnabled()) {
    ctx.set.status = 404;
    return false;
  }

  const token = getDbAdminToken();
  if (token) {
    const provided =
      ctx.headers["x-admin-token"]?.trim() ||
      ctx.headers["x-db-admin-token"]?.trim();
    if (provided === token) return true;
    ctx.set.status = 401;
    return false;
  }

  // If no token is configured, allow in dev; otherwise require auth session in prod.
  if (env.isDev) return true;

  const sessionCookieName = env.session.cookieName;
  const sessionToken = ctx.cookie[sessionCookieName]?.value;
  if (!sessionToken || typeof sessionToken !== "string") {
    ctx.set.status = 401;
    return false;
  }

  const user = await authService.validateSession(sessionToken);
  if (!user) {
    ctx.set.status = 401;
    return false;
  }

  return true;
}

function buildAdminHtml(): string {
  const enabled = isDbAdminEnabled();
  const allowWrite = isWriteAllowed();
  const keyspace = env.scylla.keyspace;

  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>DB Admin</title>
    <style>
      :root {
        color-scheme: dark;
        --bg-primary: #0d1117;
        --bg-secondary: #161b22;
        --bg-tertiary: #21262d;
        --bg-hover: #30363d;
        --border-color: #30363d;
        --border-light: #21262d;
        --text-primary: #c9d1d9;
        --text-secondary: #8b949e;
        --text-muted: #6e7681;
        --accent: #58a6ff;
        --accent-subtle: rgba(88, 166, 255, 0.1);
        --type-string: #a5d6ff;
        --type-number: #79c0ff;
        --type-boolean: #ff7b72;
        --type-null: #6e7681;
        --type-date: #d2a8ff;
        --type-uuid: #7ee787;
        --type-key: #c9d1d9;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: 13px;
        line-height: 1.5;
      }

      /* Header */
      header {
        height: 48px;
        background: var(--bg-secondary);
        border-bottom: 1px solid var(--border-color);
        display: flex;
        align-items: center;
        padding: 0 16px;
        gap: 12px;
      }

      header .logo {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
        font-size: 14px;
        color: var(--text-primary);
      }

      header .logo svg {
        width: 20px;
        height: 20px;
        color: var(--accent);
      }

      header .badge {
        background: var(--bg-tertiary);
        padding: 3px 8px;
        border-radius: 6px;
        font-size: 11px;
        color: var(--text-secondary);
        border: 1px solid var(--border-color);
      }

      header .spacer { flex: 1; }

      header input {
        background: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        padding: 5px 10px;
        color: var(--text-primary);
        font-size: 12px;
        width: 150px;
      }

      header input:focus {
        outline: none;
        border-color: var(--accent);
      }

      /* Layout */
      #app {
        display: grid;
        grid-template-columns: 260px 1fr;
        height: calc(100vh - 48px);
      }

      /* Sidebar */
      #sidebar {
        background: var(--bg-secondary);
        border-right: 1px solid var(--border-color);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      .sidebar-header {
        padding: 12px;
        border-bottom: 1px solid var(--border-color);
      }

      .sidebar-header input {
        width: 100%;
        background: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        padding: 8px 10px;
        color: var(--text-primary);
        font-size: 12px;
      }

      .sidebar-header input:focus {
        outline: none;
        border-color: var(--accent);
      }

      .sidebar-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px 6px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--text-muted);
      }

      .sidebar-title button {
        background: transparent;
        border: none;
        color: var(--text-secondary);
        cursor: pointer;
        padding: 4px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .sidebar-title button:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      #tables {
        flex: 1;
        overflow-y: auto;
        padding: 4px 8px 12px;
      }

      .table-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 10px;
        border-radius: 6px;
        cursor: pointer;
        color: var(--text-secondary);
        font-size: 13px;
        transition: background 0.1s;
      }

      .table-item:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      .table-item.active {
        background: var(--accent-subtle);
        color: var(--accent);
      }

      .table-item svg {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
        opacity: 0.7;
      }

      /* Main Content */
      #main {
        display: flex;
        flex-direction: column;
        overflow: hidden;
        background: var(--bg-primary);
      }

      /* Toolbar */
      .toolbar {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 16px;
        border-bottom: 1px solid var(--border-color);
        background: var(--bg-secondary);
      }

      .toolbar-title {
        font-weight: 600;
        font-size: 14px;
        color: var(--text-primary);
      }

      .toolbar-meta {
        color: var(--text-muted);
        font-size: 12px;
      }

      .toolbar-actions {
        margin-left: auto;
        display: flex;
        gap: 8px;
        align-items: center;
      }

      .toolbar input[type="number"] {
        width: 70px;
        background: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        padding: 5px 8px;
        color: var(--text-primary);
        font-size: 12px;
      }

      .btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 5px 12px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.1s;
        border: 1px solid transparent;
      }

      .btn-primary {
        background: var(--accent);
        color: #fff;
        border-color: var(--accent);
      }

      .btn-primary:hover {
        filter: brightness(1.1);
      }

      .btn-secondary {
        background: var(--bg-tertiary);
        border-color: var(--border-color);
        color: var(--text-primary);
      }

      .btn-secondary:hover {
        background: var(--bg-hover);
      }

      /* Tabs */
      .tabs {
        display: flex;
        border-bottom: 1px solid var(--border-color);
        background: var(--bg-secondary);
        padding: 0 16px;
      }

      .tab {
        padding: 8px 14px;
        font-size: 13px;
        color: var(--text-secondary);
        cursor: pointer;
        border-bottom: 2px solid transparent;
        margin-bottom: -1px;
        transition: all 0.1s;
      }

      .tab:hover {
        color: var(--text-primary);
      }

      .tab.active {
        color: var(--text-primary);
        border-bottom-color: var(--accent);
      }

      /* Content Area */
      .content {
        flex: 1;
        overflow: auto;
        padding: 16px;
      }

      /* Documents View */
      .documents-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .document-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        overflow: hidden;
      }

      .document-header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 14px;
        background: var(--bg-tertiary);
        cursor: pointer;
        user-select: none;
        border-bottom: 1px solid transparent;
      }

      .document-card.expanded .document-header {
        border-bottom-color: var(--border-color);
      }

      .document-header:hover {
        background: var(--bg-hover);
      }

      .document-toggle {
        width: 16px;
        height: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-muted);
        transition: transform 0.15s;
      }

      .document-card.expanded .document-toggle {
        transform: rotate(90deg);
      }

      .document-id {
        font-family: ui-monospace, 'SF Mono', Monaco, 'Cascadia Code', monospace;
        font-size: 12px;
        color: var(--type-uuid);
      }

      .document-preview {
        margin-left: auto;
        font-size: 11px;
        color: var(--text-muted);
        max-width: 400px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .document-body {
        display: none;
        padding: 16px;
        font-family: ui-monospace, 'SF Mono', Monaco, 'Cascadia Code', monospace;
        font-size: 12px;
        line-height: 1.7;
        background: var(--bg-secondary);
      }

      .document-card.expanded .document-body {
        display: block;
      }

      /* JSON Tree */
      .json-tree {
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .json-tree ul {
        margin: 0;
        padding-left: 24px;
        list-style: none;
        border-left: 1px solid var(--border-light);
        margin-left: 6px;
      }

      .json-line {
        display: flex;
        align-items: flex-start;
        padding: 3px 0;
      }

      .json-toggle {
        width: 16px;
        height: 16px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        color: var(--text-muted);
        margin-right: 4px;
        flex-shrink: 0;
        font-size: 10px;
        user-select: none;
        border-radius: 3px;
      }

      .json-toggle:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      .json-toggle.collapsed::before {
        content: '+';
        font-weight: bold;
      }

      .json-toggle.expanded::before {
        content: '-';
        font-weight: bold;
      }

      .json-toggle.leaf {
        visibility: hidden;
      }

      .json-key {
        color: var(--type-key);
        margin-right: 6px;
      }

      .json-key::after {
        content: ':';
        color: var(--text-muted);
        margin-left: 1px;
      }

      .json-value {
        word-break: break-word;
      }

      .json-value.string { color: var(--type-string); }
      .json-value.string::before,
      .json-value.string::after { content: '"'; opacity: 0.6; }

      .json-value.number { color: var(--type-number); }
      .json-value.boolean { color: var(--type-boolean); }
      .json-value.null { color: var(--type-null); font-style: italic; }
      .json-value.date { color: var(--type-date); }
      .json-value.uuid { color: var(--type-uuid); }

      .json-bracket {
        color: var(--text-muted);
      }

      .json-type {
        font-size: 10px;
        color: var(--text-muted);
        margin-left: 8px;
        opacity: 0.7;
      }

      /* Query Panel */
      .query-panel {
        display: none;
        flex-direction: column;
        gap: 12px;
      }

      .query-panel.active {
        display: flex;
      }

      .query-editor {
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        overflow: hidden;
      }

      .query-editor textarea {
        width: 100%;
        min-height: 100px;
        padding: 12px;
        background: transparent;
        border: none;
        color: var(--text-primary);
        font-family: ui-monospace, 'SF Mono', Monaco, 'Cascadia Code', monospace;
        font-size: 13px;
        line-height: 1.5;
        resize: vertical;
      }

      .query-editor textarea:focus {
        outline: none;
      }

      .query-actions {
        display: flex;
        gap: 8px;
        padding: 10px 12px;
        border-top: 1px solid var(--border-color);
        background: var(--bg-tertiary);
      }

      .query-result {
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        overflow: hidden;
      }

      .query-result-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        background: var(--bg-tertiary);
        border-bottom: 1px solid var(--border-color);
        font-size: 12px;
        color: var(--text-secondary);
      }

      .query-result-body {
        padding: 12px;
        max-height: 400px;
        overflow: auto;
      }

      /* Empty State */
      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 48px;
        color: var(--text-muted);
        text-align: center;
      }

      .empty-state svg {
        width: 40px;
        height: 40px;
        margin-bottom: 12px;
        opacity: 0.4;
      }

      /* Status Bar */
      .status-bar {
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 6px 16px;
        background: var(--bg-secondary);
        border-top: 1px solid var(--border-color);
        font-size: 11px;
        color: var(--text-muted);
      }

      .status-bar .status-item {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #3fb950;
      }

      /* Responsive */
      @media (max-width: 900px) {
        #app {
          grid-template-columns: 1fr;
        }
        #sidebar {
          display: none;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="logo">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <ellipse cx="12" cy="5" rx="9" ry="3"/>
          <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/>
          <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/>
        </svg>
        DB Admin
      </div>
      <div class="badge">${keyspace}</div>
      <div class="badge">write: ${allowWrite ? "on" : "off"}</div>
      <div class="spacer"></div>
      <input id="token" type="password" placeholder="Admin Token" />
    </header>

    <div id="app">
      <aside id="sidebar">
        <div class="sidebar-header">
          <input id="filter" type="text" placeholder="Filter collections..." />
        </div>
        <div class="sidebar-title">
          <span>Collections</span>
          <button id="reload" title="Refresh">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M23 4v6h-6M1 20v-6h6"/>
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
            </svg>
          </button>
        </div>
        <div id="tables"></div>
      </aside>

      <main id="main">
        <div class="toolbar">
          <span class="toolbar-title" id="collectionName">Select a collection</span>
          <span class="toolbar-meta" id="collectionMeta"></span>
          <div class="toolbar-actions">
            <input id="limit" type="number" min="1" max="${MAX_LIMIT}" value="${DEFAULT_LIMIT}" title="Limit" />
            <button class="btn btn-primary" id="loadDocs">Find</button>
          </div>
        </div>

        <div class="tabs">
          <div class="tab active" data-tab="documents">Documents</div>
          <div class="tab" data-tab="query">Query</div>
        </div>

        <div class="content" id="documentsTab">
          <div class="empty-state" id="emptyState">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
              <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>
            </svg>
            <div>Select a collection to view documents</div>
          </div>
          <div class="documents-list" id="documentsList"></div>
        </div>

        <div class="content query-panel" id="queryTab">
          <div class="query-editor">
            <textarea id="queryInput" spellcheck="false" placeholder="SELECT * FROM table_name LIMIT 20">SELECT * FROM users LIMIT 20</textarea>
            <div class="query-actions">
              <button class="btn btn-primary" id="runQuery">Execute</button>
              <button class="btn btn-secondary" id="copyResult">Copy</button>
            </div>
          </div>
          <div class="query-result">
            <div class="query-result-header">
              <span id="queryResultInfo">No results</span>
            </div>
            <div class="query-result-body">
              <div class="documents-list" id="queryResultDocs"></div>
            </div>
          </div>
        </div>

        <div class="status-bar">
          <div class="status-item">
            <span class="status-dot"></span>
            <span id="statusText">Ready</span>
          </div>
          <div class="status-item" id="docCount"></div>
        </div>
      </main>
    </div>

    <script>
      const $ = id => document.getElementById(id);
      const KEYSPACE = '${keyspace}';
      const state = { table: null, tables: [], docs: [] };

      function getToken() {
        return $('token').value.trim() || null;
      }

      function headers() {
        const h = { 'Content-Type': 'application/json' };
        const token = getToken();
        if (token) h['x-admin-token'] = token;
        return h;
      }

      async function api(path, options = {}) {
        const res = await fetch(path, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.message || 'HTTP ' + res.status);
        return json;
      }

      function setStatus(msg) {
        $('statusText').textContent = msg;
      }

      function detectType(value) {
        if (value === null || value === undefined) return 'null';
        if (typeof value === 'boolean') return 'boolean';
        if (typeof value === 'number') return 'number';
        if (typeof value === 'string') {
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return 'uuid';
          if (/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}/.test(value)) return 'date';
          return 'string';
        }
        if (Array.isArray(value)) return 'array';
        if (typeof value === 'object') return 'object';
        return 'unknown';
      }

      function getTypeLabel(type) {
        return { string: 'String', number: 'Int', boolean: 'Bool', null: 'Null', uuid: 'UUID', date: 'Date', array: 'Array', object: 'Object' }[type] || type;
      }

      function buildJsonTree(data, collapsed = false) {
        if (data === null || data === undefined) {
          return '<span class="json-value null">null</span>';
        }

        const type = detectType(data);

        if (type === 'array') {
          if (data.length === 0) return '<span class="json-bracket">[ ]</span>';

          const id = 'a' + Math.random().toString(36).substr(2, 9);
          let html = '<span class="json-bracket">[</span><span class="json-type">' + data.length + ' items</span>';
          html += '<div id="' + id + '" style="' + (collapsed ? 'display:none' : '') + '">';
          html += '<ul class="json-tree">';
          data.forEach((item, idx) => {
            const itemType = detectType(item);
            const hasChildren = itemType === 'object' || itemType === 'array';
            html += '<li class="json-line">';
            html += '<span class="json-toggle ' + (hasChildren ? 'expanded' : 'leaf') + '" data-target="' + id + '_' + idx + '"></span>';
            html += '<span class="json-key" style="color: var(--type-number)">' + idx + '</span>';
            if (hasChildren) {
              html += '<span id="' + id + '_' + idx + '">' + buildJsonTree(item, false) + '</span>';
            } else {
              html += buildJsonTree(item, false);
            }
            html += '</li>';
          });
          html += '</ul></div>';
          html += '<span class="json-bracket">]</span>';
          return html;
        }

        if (type === 'object') {
          const keys = Object.keys(data);
          if (keys.length === 0) return '<span class="json-bracket">{ }</span>';

          const id = 'o' + Math.random().toString(36).substr(2, 9);
          let html = '<span class="json-bracket">{</span><span class="json-type">' + keys.length + ' fields</span>';
          html += '<div id="' + id + '" style="' + (collapsed ? 'display:none' : '') + '">';
          html += '<ul class="json-tree">';
          keys.forEach(key => {
            const val = data[key];
            const valType = detectType(val);
            const hasChildren = valType === 'object' || valType === 'array';
            html += '<li class="json-line">';
            html += '<span class="json-toggle ' + (hasChildren ? 'expanded' : 'leaf') + '" data-target="' + id + '_' + key + '"></span>';
            html += '<span class="json-key">' + escapeHtml(key) + '</span>';
            if (hasChildren) {
              html += '<span id="' + id + '_' + key + '">' + buildJsonTree(val, false) + '</span>';
            } else {
              html += buildJsonTree(val, false);
              html += '<span class="json-type">' + getTypeLabel(valType) + '</span>';
            }
            html += '</li>';
          });
          html += '</ul></div>';
          html += '<span class="json-bracket">}</span>';
          return html;
        }

        const escaped = escapeHtml(String(data));
        return '<span class="json-value ' + type + '">' + escaped + '</span>';
      }

      function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      }

      function getDocumentId(doc) {
        return doc.id || doc._id || doc.key || doc.cache_key || doc.sid || doc.session_token || doc.task_sid || doc.flow_id || null;
      }

      function getDocumentPreview(doc) {
        const keys = Object.keys(doc).filter(k => k !== 'id' && k !== '_id');
        const preview = keys.slice(0, 3).map(k => {
          const v = doc[k];
          if (v === null) return k + ': null';
          if (typeof v === 'string') return k + ': "' + v.substring(0, 20) + (v.length > 20 ? '...' : '') + '"';
          if (typeof v === 'number' || typeof v === 'boolean') return k + ': ' + v;
          if (Array.isArray(v)) return k + ': [' + v.length + ']';
          if (typeof v === 'object') return k + ': {...}';
          return k + ': ' + String(v).substring(0, 15);
        }).join(', ');
        return preview + (keys.length > 3 ? ', ...' : '');
      }

      function renderDocuments(docs, container) {
        container.innerHTML = '';

        if (!docs || docs.length === 0) {
          container.innerHTML = '<div class="empty-state"><div>No documents found</div></div>';
          return;
        }

        docs.forEach((doc, idx) => {
          const card = document.createElement('div');
          card.className = 'document-card' + (idx < 3 ? ' expanded' : '');

          const docId = getDocumentId(doc);
          const preview = getDocumentPreview(doc);

          card.innerHTML = \`
            <div class="document-header">
              <span class="document-toggle">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5l8 7-8 7V5z"/>
                </svg>
              </span>
              <span class="document-id">\${docId ? escapeHtml(String(docId)) : 'Document #' + (idx + 1)}</span>
              <span class="document-preview">\${escapeHtml(preview)}</span>
            </div>
            <div class="document-body">
              \${buildJsonTree(doc, false)}
            </div>
          \`;

          card.querySelector('.document-header').onclick = () => {
            card.classList.toggle('expanded');
          };

          container.appendChild(card);
        });

        container.querySelectorAll('.json-toggle:not(.leaf)').forEach(toggle => {
          toggle.onclick = (e) => {
            e.stopPropagation();
            const targetId = toggle.dataset.target;
            if (!targetId) return;
            const target = document.getElementById(targetId);
            if (!target) return;

            if (toggle.classList.contains('expanded')) {
              toggle.classList.remove('expanded');
              toggle.classList.add('collapsed');
              target.style.display = 'none';
            } else {
              toggle.classList.remove('collapsed');
              toggle.classList.add('expanded');
              target.style.display = '';
            }
          };
        });
      }

      function renderTables() {
        const filter = $('filter').value.trim().toLowerCase();
        const filtered = state.tables.filter(t => !filter || t.toLowerCase().includes(filter));
        const root = $('tables');
        root.innerHTML = '';

        filtered.forEach(table => {
          const div = document.createElement('div');
          div.className = 'table-item' + (state.table === table ? ' active' : '');
          div.innerHTML = \`
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <path d="M3 9h18M9 21V9"/>
            </svg>
            \${table}
          \`;
          div.onclick = () => selectTable(table);
          root.appendChild(div);
        });
      }

      async function loadTables() {
        setStatus('Loading...');
        const data = await api('/db-admin/api/tables?keyspace=' + encodeURIComponent(KEYSPACE));
        state.tables = data.data || [];
        renderTables();
        setStatus('Ready');
      }

      async function selectTable(table) {
        state.table = table;
        renderTables();
        $('collectionName').textContent = table;
        $('collectionMeta').textContent = '';
        $('emptyState').style.display = 'none';
        $('documentsList').innerHTML = '';
        await loadDocs();
      }

      async function loadDocs() {
        if (!state.table) return;
        const limit = Math.max(1, Math.min(${MAX_LIMIT}, parseInt($('limit').value || '${DEFAULT_LIMIT}', 10)));
        setStatus('Finding...');
        const data = await api('/db-admin/api/table/' + encodeURIComponent(state.table) + '/rows?keyspace=' + encodeURIComponent(KEYSPACE) + '&limit=' + limit);
        state.docs = data.data || [];
        renderDocuments(state.docs, $('documentsList'));
        $('docCount').textContent = state.docs.length + ' docs';
        setStatus('Ready');
      }

      async function runQuery() {
        const q = $('queryInput').value;
        setStatus('Executing...');
        try {
          const data = await api('/db-admin/api/query', {
            method: 'POST',
            body: JSON.stringify({ query: q, keyspace: KEYSPACE })
          });
          const docs = data.data || [];
          renderDocuments(docs, $('queryResultDocs'));
          $('queryResultInfo').textContent = docs.length + ' documents';
          setStatus('Done');
        } catch (e) {
          $('queryResultDocs').innerHTML = '<div style="color: #f85149; padding: 12px;">' + escapeHtml(e.message) + '</div>';
          $('queryResultInfo').textContent = 'Error';
          setStatus('Failed');
        }
      }

      document.querySelectorAll('.tab').forEach(tab => {
        tab.onclick = () => {
          document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          const tabName = tab.dataset.tab;
          $('documentsTab').style.display = tabName === 'documents' ? '' : 'none';
          $('queryTab').classList.toggle('active', tabName === 'query');
        };
      });

      $('reload').onclick = loadTables;
      $('filter').oninput = renderTables;
      $('loadDocs').onclick = loadDocs;
      $('runQuery').onclick = runQuery;
      $('copyResult').onclick = async () => {
        await navigator.clipboard.writeText(JSON.stringify(state.docs, null, 2));
        setStatus('Copied');
      };

      (async () => {
        try {
          const savedToken = localStorage.getItem('db_admin_token');
          if (savedToken) $('token').value = savedToken;
          $('token').addEventListener('input', () => localStorage.setItem('db_admin_token', $('token').value));

          await loadTables();
          if (state.tables[0]) await selectTable(state.tables[0]);
        } catch (e) {
          setStatus('Error: ' + e.message);
        }
      })();
    </script>
  </body>
</html>`;
}

export const dbAdminController = new Elysia({ prefix: "/db-admin" })
  .get(
    "/",
    async ({ headers, cookie, set }) => {
      const ok = await requireDbAdminAccess({ headers, cookie, set });
      if (!ok) return { message: "Not authorized" };
      set.headers["content-type"] = "text/html; charset=utf-8";
      return buildAdminHtml();
    },
    {
      detail: {
        summary: "DB Admin UI",
        tags: ["DB Admin"],
      },
    },
  )
  .get(
    "/api/keyspaces",
    async ({ headers, cookie, set }) => {
      const ok = await requireDbAdminAccess({ headers, cookie, set });
      if (!ok) return { message: "Not authorized" };

      const result = await getClient().execute(
        "SELECT keyspace_name FROM system_schema.keyspaces",
      );
      const keyspaces = result.rows
        .map((r) => rowToJson(r).keyspace_name)
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .sort((a, b) => a.localeCompare(b));

      return { data: keyspaces, defaultKeyspace: env.scylla.keyspace };
    },
    {
      detail: {
        summary: "List keyspaces",
        tags: ["DB Admin"],
      },
    },
  )
  .get(
    "/api/tables",
    async ({ query, headers, cookie, set }) => {
      const ok = await requireDbAdminAccess({ headers, cookie, set });
      if (!ok) return { message: "Not authorized" };

      const keyspaceRaw =
        typeof query.keyspace === "string" && query.keyspace.trim().length > 0
          ? query.keyspace.trim()
          : env.scylla.keyspace;

      if (!isValidIdentifier(keyspaceRaw)) {
        set.status = 400;
        return { message: "Invalid keyspace" };
      }

      const result = await getClient().execute(
        "SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?",
        [keyspaceRaw],
        { prepare: true },
      );

      const tables = result.rows
        .map((r) => rowToJson(r).table_name)
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .sort((a, b) => a.localeCompare(b));

      return { data: tables, keyspace: keyspaceRaw };
    },
    {
      query: t.Object({
        keyspace: t.Optional(t.String()),
      }),
      detail: {
        summary: "List tables",
        tags: ["DB Admin"],
      },
    },
  )
  .get(
    "/api/table/:table/rows",
    async ({ params, query, headers, cookie, set }) => {
      const ok = await requireDbAdminAccess({ headers, cookie, set });
      if (!ok) return { message: "Not authorized" };

      const keyspaceRaw =
        typeof query.keyspace === "string" && query.keyspace.trim().length > 0
          ? query.keyspace.trim()
          : env.scylla.keyspace;
      const tableRaw = params.table;

      if (!isValidIdentifier(keyspaceRaw)) {
        set.status = 400;
        return { message: "Invalid keyspace" };
      }
      if (!isValidIdentifier(tableRaw)) {
        set.status = 400;
        return { message: "Invalid table" };
      }

      const limitNumber = Math.min(
        MAX_LIMIT,
        Math.max(
          1,
          Number.isFinite(Number(query.limit))
            ? Math.floor(Number(query.limit))
            : DEFAULT_LIMIT,
        ),
      );

      const cql = `SELECT * FROM "${keyspaceRaw}"."${tableRaw}" LIMIT ${limitNumber}`;
      const result = await getClient().execute(cql);

      return {
        data: result.rows.map(rowToJson),
        keyspace: keyspaceRaw,
        table: tableRaw,
      };
    },
    {
      params: t.Object({
        table: t.String({ minLength: 1 }),
      }),
      query: t.Object({
        keyspace: t.Optional(t.String()),
        limit: t.Optional(t.Numeric({ default: DEFAULT_LIMIT })),
      }),
      detail: {
        summary: "List rows (limited)",
        tags: ["DB Admin"],
      },
    },
  )
  .post(
    "/api/query",
    async ({ body, headers, cookie, set }) => {
      const ok = await requireDbAdminAccess({ headers, cookie, set });
      if (!ok) return { message: "Not authorized" };

      const keyspaceRaw =
        typeof body.keyspace === "string" && body.keyspace.trim().length > 0
          ? body.keyspace.trim()
          : env.scylla.keyspace;

      if (!isValidIdentifier(keyspaceRaw)) {
        set.status = 400;
        return { message: "Invalid keyspace" };
      }

      const raw = body.query;
      const trimmed = raw.trim();
      if (!trimmed) {
        set.status = 400;
        return { message: "Query is required" };
      }

      const cleaned = trimmed.replace(/;\s*$/, "");
      if (cleaned.includes(";")) {
        set.status = 400;
        return { message: "Only one statement is allowed" };
      }

      const startsWithSelect = /^\s*select\b/i.test(cleaned);
      if (!startsWithSelect && !isWriteAllowed()) {
        set.status = 400;
        return {
          message:
            "Only SELECT queries are allowed (DB_ADMIN_ALLOW_WRITE=false)",
        };
      }

      let finalQuery = cleaned;

      if (startsWithSelect && !/\blimit\s+\d+\b/i.test(finalQuery)) {
        const limit = MAX_LIMIT;
        finalQuery = finalQuery.replace(
          /\s+ALLOW\s+FILTERING\s*$/i,
          (m) => ` LIMIT ${limit}${m}`,
        );
        if (!/\blimit\s+\d+\b/i.test(finalQuery)) {
          finalQuery = `${finalQuery} LIMIT ${limit}`;
        }
      }

      finalQuery = qualifyQueryWithKeyspace(finalQuery, keyspaceRaw);

      try {
        const result = await getClient().execute(finalQuery);
        return {
          data: result.rows.map(rowToJson),
          rowCount: result.rowLength,
          query: finalQuery,
          keyspace: keyspaceRaw,
        };
      } catch (err) {
        set.status = 400;
        const message = err instanceof Error ? err.message : "Query failed";
        return { message, query: finalQuery, keyspace: keyspaceRaw };
      }
    },
    {
      body: t.Object({
        query: t.String({ minLength: 1 }),
        keyspace: t.Optional(t.String()),
      }),
      detail: {
        summary: "Run a query (SELECT by default)",
        tags: ["DB Admin"],
      },
    },
  );
