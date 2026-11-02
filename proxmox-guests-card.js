/**
 * proxmox-guests-card
 * Status + controls for Proxmox VMs and LXC containers in Home Assistant.
 *
 * No dependencies. Works with any integration that exposes the guests as
 * entities (e.g. the HACS "ha-proxmoxve" integration or the core Proxmox VE one):
 * you simply map each guest to the entities you want to show.
 *
 * Easiest (dougiteixeira/proxmoxve, needs an admin user):
 *
 * type: custom:proxmox-guests-card
 * discover: true
 * # optional: include: "^web|db", exclude: "template", type: lxc
 * # optional per-guest overrides: guests: [{ match: "Pi-hole", name: "DNS", node: "pve1" }]
 *
 * Or map entities manually:
 *
 * type: custom:proxmox-guests-card
 * title: Proxmox
 * guests:
 *   - name: Home Assistant
 *     type: vm                       # vm | lxc  (icon only)
 *     node: pve1                     # optional subtitle
 *     status: binary_sensor.pve1_vm_homeassistant_status
 *     cpu: sensor.pve1_vm_homeassistant_cpu_usage
 *     memory: sensor.pve1_vm_homeassistant_memory_usage_percentage
 *     uptime: sensor.pve1_vm_homeassistant_uptime
 *     start: button.pve1_vm_homeassistant_start
 *     shutdown: button.pve1_vm_homeassistant_shutdown
 *     reboot: button.pve1_vm_homeassistant_reboot
 *     stop: button.pve1_vm_homeassistant_stop
 *   - name: Pi-hole
 *     type: lxc
 *     status: binary_sensor.pve1_lxc_pihole_status
 *     cpu: sensor.pve1_lxc_pihole_cpu_usage
 *     memory: sensor.pve1_lxc_pihole_memory_usage_percentage
 *     start: button.pve1_lxc_pihole_start
 *     shutdown: button.pve1_lxc_pihole_shutdown
 */

const PGC_VERSION = "1.0.0";

const ACTIONS = [
  { key: "start", icon: "mdi:play", label: "Start", when: ["stopped"], confirm: false },
  { key: "shutdown", icon: "mdi:power", label: "Shutdown", when: ["running"], confirm: true },
  { key: "reboot", icon: "mdi:restart", label: "Reboot", when: ["running"], confirm: true },
  { key: "stop", icon: "mdi:stop", label: "Force stop", when: ["running", "paused"], confirm: true, danger: true },
];

const RUNNING_STATES = ["on", "running", "online", "true", "started"];
const STOPPED_STATES = ["off", "stopped", "offline", "false", "shutdown"];
const BAD_STATES = ["unavailable", "unknown", "none", ""];

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

class ProxmoxGuestsCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._armed = null; // { id, timer } – action waiting for second click
    this._sig = "";
    this._busy = new Set();

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card { overflow: hidden; }
        .header {
          display: flex; align-items: center; gap: 12px; padding: 16px 16px 6px;
        }
        .header.ok { --tone: var(--success-color, #43a047); }
        .header.warn { --tone: var(--warning-color, #ffa000); }
        .header.off { --tone: var(--disabled-text-color, #9e9e9e); }
        .h-icon {
          flex: none; width: 44px; height: 44px; border-radius: 12px; display: flex; align-items: center; justify-content: center;
          background: color-mix(in srgb, var(--secondary-text-color) 16%, transparent); color: var(--tone);
        }
        .h-text { flex: 1; min-width: 0; }
        .title { font-size: 1.05rem; font-weight: 600; color: var(--primary-text-color); line-height: 1.25;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .subtitle { font-size: .875rem; color: var(--secondary-text-color); line-height: 1.3;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pill {
          flex: none; display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 999px;
          font-size: .85rem; font-weight: 600; white-space: nowrap; color: var(--tone);
          background: color-mix(in srgb, var(--tone) 16%, transparent);
        }
        .pill ha-icon { --mdc-icon-size: 18px; }
        .list { padding: 4px 8px 8px; }
        .row {
          display: grid; grid-template-columns: 40px 1fr auto; align-items: center;
          gap: 4px 12px; padding: 10px 8px; border-radius: 12px;
        }
        .row + .row { border-top: 1px solid var(--divider-color); border-radius: 0; }
        .icon-wrap {
          position: relative; width: 40px; height: 40px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          background: color-mix(in srgb, var(--state-color) 15%, transparent);
          color: var(--state-color); cursor: pointer;
        }
        .dot {
          position: absolute; right: 0; bottom: 0; width: 11px; height: 11px; border-radius: 50%;
          background: var(--state-color); border: 2px solid var(--card-background-color, #fff);
        }
        .running { --state-color: var(--success-color, #43a047); }
        .stopped { --state-color: var(--disabled-text-color, #9e9e9e); }
        .unavailable, .paused { --state-color: var(--warning-color, #ffa000); }
        .info { min-width: 0; cursor: pointer; }
        .name { font-weight: 500; color: var(--primary-text-color); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .sub { font-size: .8rem; color: var(--secondary-text-color); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .actions { display: flex; gap: 2px; }
        .btn {
          --size: 34px; width: var(--size); height: var(--size); border-radius: 50%;
          border: none; background: transparent; color: var(--secondary-text-color);
          display: inline-flex; align-items: center; justify-content: center;
          cursor: pointer; padding: 0; transition: background .15s, color .15s;
        }
        .btn:hover { background: var(--secondary-background-color); color: var(--primary-text-color); }
        .btn.danger:hover { color: var(--error-color, #db4437); }
        .btn.armed { background: var(--warning-color, #ffa000); color: #fff; animation: pulse 1s infinite; }
        .btn.armed.danger { background: var(--error-color, #db4437); }
        .btn.busy { opacity: .4; pointer-events: none; }
        .btn.start { color: var(--success-color, #43a047); }
        @keyframes pulse { 50% { opacity: .65; } }
        .meters {
          grid-column: 2 / 4; display: flex; gap: 14px; align-items: center; flex-wrap: wrap;
          font-size: .75rem; color: var(--secondary-text-color); margin-top: 2px;
        }
        .meter { display: flex; align-items: center; gap: 6px; flex: 1 1 110px; min-width: 110px; }
        .meter .lbl { width: 30px; flex: none; }
        .bar { flex: 1; height: 6px; border-radius: 3px; background: color-mix(in srgb, var(--secondary-text-color) 28%, transparent); overflow: hidden; }
        .bar > span { display: block; height: 100%; border-radius: 3px; background: var(--primary-color); transition: width .4s; }
        .bar > span.warn { background: var(--warning-color, #ffa000); }
        .bar > span.crit { background: var(--error-color, #db4437); }
        .meter .val { min-width: 4ch; text-align: left; flex: none; font-variant-numeric: tabular-nums; }
        .chip { display: inline-flex; gap: 4px; align-items: center; flex: none; }
        .chip ha-icon { --mdc-icon-size: 14px; }
        .fold {
          display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box;
          margin: 0; padding: 10px 8px; border: none; border-top: 1px solid var(--divider-color);
          background: transparent; color: var(--secondary-text-color); font: inherit; font-size: .9rem;
          cursor: pointer; text-align: left;
        }
        .fold:hover { color: var(--primary-text-color); }
        .fold .ft { flex: 1; font-weight: 500; }
        .fold .fc { font-size: .8rem; }
        .fold ha-icon { --mdc-icon-size: 20px; transition: transform .2s; }
        .fold.open ha-icon { transform: rotate(180deg); }
        .compact .row { padding: 6px 8px; }
        .compact .meters { display: none; }
        .empty, .err { padding: 16px; color: var(--secondary-text-color); }
        .err { color: var(--error-color, #db4437); }
      </style>
      <ha-card><div id="root"></div></ha-card>`;

    this.shadowRoot.getElementById("root").addEventListener("click", (e) => this._onClick(e));
  }

  /* ---------- HA card API ---------- */

  setConfig(config) {
    if (!config) throw new Error("Invalid configuration.");
    if (!config.discover && (!Array.isArray(config.guests) || config.guests.length === 0)) {
      throw new Error("Set `discover: true` or define a `guests` list.");
    }
    (config.guests || []).forEach((g, i) => {
      if (!g.status && !g.name && !g.match) throw new Error(`guests[${i}] needs at least a name, a match or a status entity.`);
    });
    this._config = {
      title: "Proxmox",
      compact: false,
      show_actions: true,
      show_summary: true,
      collapsed_title: "More guests",
      collapsed_open: false,
      discover: false,
      warn_at: 75,
      crit_at: 90,
      ...config,
    };
    this._sig = "";
    this._discovered = null;
    this._discovering = false;
    this._discoverError = null;
    this._render();
  }

  get _list() {
    const manual = this._config?.guests || [];
    if (!this._config?.discover) return manual;
    return this._merged || [];
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._config) return;
    if (this._config.discover && !this._discovered && !this._discovering) this._discover();
    if (first) this._sig = "";
    const sig = this._signature();
    if (sig !== this._sig) {
      this._sig = sig;
      this._render();
    }
  }

  getCardSize() {
    return 1 + (this._list.length || 1) * (this._config?.compact ? 1 : 2);
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  static getConfigElement() {
    return document.createElement("proxmox-guests-card-editor");
  }

  static getStubConfig(hass) {
    return {
      title: "Proxmox",
      guests: [{ name: "My VM", type: "vm" }],
    };
  }

  /* ---------- auto-discovery (dougiteixeira/proxmoxve) ---------- */

  async _discover() {
    this._discovering = true;
    try {
      const [ents, devs] = await Promise.all([
        this._hass.callWS({ type: "config/entity_registry/list" }),
        this._hass.callWS({ type: "config/device_registry/list" }),
      ]);
      const devById = Object.fromEntries(devs.map((d) => [d.id, d]));
      const byDevice = {};
      ents.filter((e) => e.platform === "proxmoxve" && e.device_id && !e.disabled_by)
        .forEach((e) => (byDevice[e.device_id] ||= []).push(e));

      const guests = [];
      for (const [devId, list] of Object.entries(byDevice)) {
        const text = list.map((e) => e.entity_id).join(" ");
        const m = text.match(/(?:^|[._])(qemu|lxc)[_.]/i);
        if (!m) continue; // node / storage / cluster devices
        const g = { type: m[1].toLowerCase() === "lxc" ? "lxc" : "vm", _device: devId };
        const dev = devById[devId];
        g.name = dev?.name_by_user || dev?.name || list[0].original_name;
        const pick = {};
        const set = (k, e, score) => { if (!pick[k] || score > pick[k].score) pick[k] = { id: e.entity_id, score }; };
        for (const e of list) {
          const dom = e.entity_id.split(".")[0];
          const t = (e.translation_key || e.entity_id.split(".")[1] || "").toLowerCase();
          if (dom === "button") {
            const b = t.match(/(?:^|_)(start|stop|shutdown|reboot)$/);
            if (b) set(b[1], e, 1);
          } else if (dom === "sensor") {
            if (/status(_raw)?$/.test(t)) set("status", e, /_raw$/.test(t) ? 1 : 2);
            else if (/cpu_used$|^cpu$/.test(t) && !/host/.test(t)) set("cpu", e, 1);
            else if (/uptime|last_?boot|boot_?time/.test(t)) set("uptime", e, /uptime/.test(t) ? 1 : 2);
            else if (/memory/.test(t) && !/free|total|max|host/.test(t)) set("memory", e, 1);
            else if (/disk/.test(t) && !/read|write|total|free|max|io|host/.test(t)) set("disk", e, 1);
          }
        }
        Object.entries(pick).forEach(([k, v]) => (g[k] = v.id));
        if (g.status) guests.push(g);
      }
      guests.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
      this._discovered = guests;
      this._discoverInfo = { entities: ents.filter((e) => e.platform === "proxmoxve").length, devices: Object.keys(byDevice).length };
      this._discoverError = null;
    } catch (err) {
      this._discovered = [];
      this._discoverError = err?.message || String(err);
    }
    this._discovering = false;
    this._applyDiscovery();
    this._sig = "";
    if (this._hass) this._render();
  }

  _applyDiscovery() {
    const c = this._config;
    const test = (re, v) => { try { return new RegExp(re, "i").test(v || ""); } catch { return false; } };
    let list = (this._discovered || []).filter((g) =>
      (!c.include || test(c.include, g.name)) && (!c.exclude || !test(c.exclude, g.name)) &&
      (!c.type || c.type === g.type));
    // Manual `guests` entries override discovered ones with the same name.
    const overrides = c.guests || [];
    list = list.map((g) => {
      const o = overrides.find((x) => String(x.match || x.name).toLowerCase() === String(g.name).toLowerCase());
      return o ? { ...g, ...o, _origName: g.name } : g;
    });
    // Guests listed manually come first, in the order you arranged them; the rest follow alphabetically.
    const rank = (g) => {
      const idx = overrides.findIndex((x) => String(x.match || x.name).toLowerCase() === String(g._origName || g.name).toLowerCase());
      return idx < 0 ? Infinity : idx;
    };
    this._merged = list.map((g, i) => ({ g, i })).sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i).map((x) => x.g);
  }

  /* ---------- helpers ---------- */

  _entityIds() {
    const ids = [];
    (this._list || []).forEach((g) => {
      ["status", "cpu", "memory", "disk", "uptime", ...ACTIONS.map((a) => a.key)].forEach((k) => g[k] && ids.push(g[k]));
    });
    return ids;
  }

  _signature() {
    const s = this._hass.states;
    return this._entityIds().map((id) => {
      const st = s[id];
      return st ? `${st.state}|${st.last_changed}` : "-";
    }).join(";") + (this._armed ? "#" + this._armed.id : "") + "#" + [...this._busy].join(",");
  }

  _guestState(g) {
    const st = g.status ? this._hass.states[g.status] : null;
    if (!st) return "unavailable";
    const v = String(st.state).toLowerCase();
    if (BAD_STATES.includes(v)) return "unavailable";
    if (RUNNING_STATES.includes(v)) return "running";
    if (STOPPED_STATES.includes(v)) return "stopped";
    return "paused"; // suspended, paused, prelaunch, io-error, ...
  }

  _metric(id) {
    if (!id) return null;
    const st = this._hass.states[id];
    if (!st) return null;
    const v = parseFloat(st.state);
    if (isNaN(v)) return null;
    const unit = st.attributes.unit_of_measurement || "";
    return { v, unit, isPct: unit === "%" };
  }

  _uptime(id) {
    if (!id) return null;
    const st = this._hass.states[id];
    if (!st || BAD_STATES.includes(String(st.state).toLowerCase())) return null;
    let secs;
    if (st.attributes.device_class === "timestamp" || /^\d{4}-\d\d-\d\dT/.test(st.state)) {
      secs = (Date.now() - new Date(st.state).getTime()) / 1000;
    } else {
      const n = parseFloat(st.state);
      if (isNaN(n)) return null;
      const mult = { s: 1, min: 60, h: 3600, d: 86400 }[st.attributes.unit_of_measurement] ?? 1;
      secs = n * mult;
    }
    if (!isFinite(secs) || secs < 0) return null;
    const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  }

  _meter(label, m) {
    if (!m) return "";
    const { warn_at, crit_at } = this._config;
    if (!m.isPct) {
      return `<span class="chip">${esc(label)} ${esc(Math.round(m.v * 10) / 10)}${esc(m.unit)}</span>`;
    }
    const pct = Math.max(0, Math.min(100, m.v));
    const cls = pct >= crit_at ? "crit" : pct >= warn_at ? "warn" : "";
    return `<div class="meter"><span class="lbl">${label}</span>
      <div class="bar"><span class="${cls}" style="width:${pct}%"></span></div>
      <span class="val">${Math.round(pct)}%</span></div>`;
  }

  /* ---------- render ---------- */

  _render() {
    const root = this.shadowRoot.getElementById("root");
    if (!root || !this._config) return;
    if (!this._hass) {
      root.innerHTML = `<div class="empty">Loading…</div>`;
      return;
    }
    const c = this._config;
    if (c.discover && !this._discovered) {
      root.innerHTML = `<div class="empty">Discovering Proxmox guests…</div>`;
      return;
    }
    if (c.discover && this._discoverError) {
      root.innerHTML = `<div class="err">Auto-discovery failed (${esc(this._discoverError)}). It needs an admin user; otherwise list the guests manually under <code>guests:</code>.</div>`;
      return;
    }
    if (!this._list.length) {
      const i = this._discoverInfo;
      root.innerHTML = `<div class="empty">No Proxmox VMs or containers found${i ? ` (saw ${i.entities} proxmoxve entities on ${i.devices} devices)` : ""}.
        Add guests by hand with the card editor (Edit card → Guests), or in YAML under <code>guests:</code>.</div>`;
      return;
    }
    const states = this._list.map((g) => this._guestState(g));
    const running = states.filter((s) => s === "running").length;

    const rows = this._list.map((g, i) => {
      const state = states[i];
      const type = String(g.type || "vm").toLowerCase();
      const icon = g.icon || (type === "lxc" ? "mdi:cube-outline" : "mdi:server");
      const name = g.name || this._hass.states[g.status]?.attributes.friendly_name || g.status;
      const up = state === "running" ? this._uptime(g.uptime) : null;
      const raw = String(this._hass.states[g.status]?.state || "");
      const label = state === "unavailable" ? "Unavailable" : state === "running" ? "Running" : state === "stopped" ? "Stopped"
        : raw.charAt(0).toUpperCase() + raw.slice(1).replace(/[_-]/g, " ");
      const subParts = [type.toUpperCase(), g.node, label];
      if (up) subParts.push(`up ${up}`);

      const meters = state === "running"
        ? [this._meter("CPU", this._metric(g.cpu)), this._meter("RAM", this._metric(g.memory)), this._meter("Disk", this._metric(g.disk))].join("")
        : "";

      const actions = c.show_actions
        ? ACTIONS.filter((a) => g[a.key] && (a.when.includes(state) || state === "unavailable" && a.key === "start"))
            .map((a) => {
              const id = `${i}:${a.key}`;
              const armed = this._armed?.id === id;
              const busy = this._busy.has(id);
              return `<button class="btn ${a.key} ${a.danger ? "danger" : ""} ${armed ? "armed" : ""} ${busy ? "busy" : ""}"
                  data-guest="${i}" data-action="${a.key}"
                  title="${armed ? "Click again to confirm" : esc(a.label)}">
                  <ha-icon icon="${armed ? "mdi:check" : a.icon}"></ha-icon></button>`;
            }).join("")
        : "";

      const html = `<div class="row ${state}">
        <div class="icon-wrap" data-more="${i}"><ha-icon icon="${esc(icon)}"></ha-icon><span class="dot"></span></div>
        <div class="info" data-more="${i}">
          <div class="name">${esc(name)}</div>
          <div class="sub">${esc(subParts.filter(Boolean).join(" · "))}</div>
        </div>
        <div class="actions">${actions}</div>
        ${meters ? `<div class="meters">${meters}</div>` : ""}
      </div>`;
      return { html, folded: !!g.collapsed, running: state === "running" };
    });
    const main = rows.filter((r) => !r.folded);
    const folded = rows.filter((r) => r.folded);
    const foldOpen = this._foldOpen ?? !!c.collapsed_open;
    const foldHtml = folded.length ? `
      <button class="fold ${foldOpen ? "open" : ""}" data-fold aria-expanded="${foldOpen}">
        <span class="ft">${esc(c.collapsed_title)}</span>
        <span class="fc">${folded.length} · ${folded.filter((r) => r.running).length} running</span>
        <ha-icon icon="mdi:chevron-down"></ha-icon>
      </button>
      ${foldOpen ? `<div class="foldbody">${folded.map((r) => r.html).join("")}</div>` : ""}` : "";

    const total = this._list.length;
    const count = (st) => states.filter((x) => x === st).length;
    const parts = [];
    if (count("stopped")) parts.push(`${count("stopped")} stopped`);
    if (count("paused")) parts.push(`${count("paused")} paused`);
    if (count("unavailable")) parts.push(`${count("unavailable")} unavailable`);
    // Stopped guests are usually intentional; only paused/unavailable ones turn the header amber.
    const tone = running === 0 ? "off" : count("paused") + count("unavailable") ? "warn" : "ok";
    const subtitle = running === total ? "Everything running"
      : running === 0 && count("stopped") === total ? "All guests stopped" : parts.join(" · ");
    const headIcon = tone === "ok" ? "mdi:check-circle-outline" : tone === "warn" ? "mdi:alert-circle-outline" : "mdi:power-sleep";

    root.innerHTML = `
      ${c.title || c.show_summary ? `<div class="header ${tone}">
        <div class="h-icon"><ha-icon icon="${headIcon}"></ha-icon></div>
        <div class="h-text">
          ${c.title ? `<div class="title">${esc(c.title)}</div>` : ""}
          <div class="subtitle">${esc(subtitle)}</div>
        </div>
        ${c.show_summary ? `<div class="pill"><ha-icon icon="mdi:server"></ha-icon><span>${running} / ${total} running</span></div>` : ""}
      </div>` : ""}
      <div class="list ${c.compact ? "compact" : ""}">${main.map((r) => r.html).join("")}${foldHtml}</div>`;
  }

  /* ---------- interaction ---------- */

  _onClick(e) {
    const btn = e.target.closest("[data-action]");
    if (btn) {
      e.stopPropagation();
      this._handleAction(Number(btn.dataset.guest), btn.dataset.action);
      return;
    }
    if (e.target.closest("[data-fold]")) {
      this._foldOpen = !(this._foldOpen ?? !!this._config.collapsed_open);
      this._render();
      return;
    }
    const more = e.target.closest("[data-more]");
    if (more) {
      const g = this._list[Number(more.dataset.more)];
      const entityId = g.status || g.cpu || g.memory;
      if (entityId) {
        this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId }, bubbles: true, composed: true }));
      }
    }
  }

  _handleAction(i, key) {
    const g = this._list[i];
    const action = ACTIONS.find((a) => a.key === key);
    const entityId = g[key];
    if (!action || !entityId) return;
    const id = `${i}:${key}`;

    if (action.confirm && this._armed?.id !== id) {
      clearTimeout(this._armed?.timer);
      this._armed = { id, timer: setTimeout(() => { this._armed = null; this._sig = ""; this._render(); }, 3500) };
      this._render();
      return;
    }
    clearTimeout(this._armed?.timer);
    this._armed = null;

    this._busy.add(id);
    this._render();
    this._call(entityId, key)
      .catch((err) => {
        console.error("proxmox-guests-card:", err);
        this.dispatchEvent(new CustomEvent("hass-notification", {
          detail: { message: `Failed to ${action.label.toLowerCase()} ${g.name || entityId}: ${err.message || err}` },
          bubbles: true, composed: true,
        }));
      })
      .finally(() => {
        // Keep the spinner-ish state briefly; Proxmox takes a moment to update state.
        setTimeout(() => { this._busy.delete(id); this._sig = ""; this._render(); }, 4000);
      });
  }

  _call(entityId, key) {
    const domain = entityId.split(".")[0];
    const data = { entity_id: entityId };
    if (domain === "button" || domain === "input_button") return this._hass.callService(domain, "press", data);
    if (domain === "script") return this._hass.callService("script", "turn_on", data);
    if (domain === "scene") return this._hass.callService("scene", "turn_on", data);
    // switch-style entities: start => on, everything else => off
    return this._hass.callService(domain === "switch" || domain === "input_boolean" ? domain : "homeassistant",
      key === "start" ? "turn_on" : "turn_off", data);
  }
}


/* ---------------- visual editor ---------------- */

const EDITOR_LABELS = {
  title: "Title", discover: "Auto-discover guests (proxmoxve integration, admin only)", compact: "Compact (hide usage bars)",
  show_actions: "Show power buttons", show_summary: "Show running count",
  collapsed_title: "Title of the collapsed section", collapsed_open: "Start with the collapsed section open",
  collapsed: "Put in collapsed section",
  name: "Name", type: "Type", node: "Node (optional)", status: "Status entity",
  cpu: "CPU usage entity", memory: "Memory usage entity", disk: "Disk usage entity", uptime: "Uptime or last boot entity",
  start: "Start button", shutdown: "Shutdown button", reboot: "Reboot button", stop: "Force stop button",
};
const SENSOR = { entity: { domain: ["sensor", "binary_sensor"] } };
const CONTROL = { entity: { domain: ["button", "switch", "script"] } };
const GENERAL_SCHEMA = [
  { name: "title", selector: { text: {} } },
  { name: "discover", selector: { boolean: {} } },
  { name: "compact", selector: { boolean: {} } },
  { name: "show_actions", selector: { boolean: {} } },
  { name: "show_summary", selector: { boolean: {} } },
  { name: "collapsed_title", selector: { text: {} } },
  { name: "collapsed_open", selector: { boolean: {} } },
];
const GUEST_SCHEMA = [
  { name: "name", selector: { text: {} } },
  { name: "type", selector: { select: { mode: "dropdown", options: [{ value: "vm", label: "Virtual machine (QEMU)" }, { value: "lxc", label: "Container (LXC)" }] } } },
  { name: "node", selector: { text: {} } },
  { name: "collapsed", selector: { boolean: {} } },
  { name: "status", selector: SENSOR },
  { name: "cpu", selector: SENSOR },
  { name: "memory", selector: SENSOR },
  { name: "disk", selector: SENSOR },
  { name: "uptime", selector: SENSOR },
  { name: "start", selector: CONTROL },
  { name: "shutdown", selector: CONTROL },
  { name: "reboot", selector: CONTROL },
  { name: "stop", selector: CONTROL },
];

class ProxmoxGuestsCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = { guests: [] };
  }

  set hass(hass) {
    this._hass = hass;
    this.shadowRoot.querySelectorAll("ha-form").forEach((f) => (f.hass = hass));
  }

  setConfig(config) {
    // HA echoes our own config-changed back here; rebuilding would drop focus while typing.
    if (this._lastEmitted && JSON.stringify(config) === this._lastEmitted) return;
    this._config = { ...config, guests: (config.guests || []).map((g) => ({ ...g })) };
    this._build();
  }

  _move(from, to) {
    const gs = this._config.guests;
    if (from === to || from < 0 || to < 0 || from >= gs.length || to >= gs.length) return;
    const [g] = gs.splice(from, 1);
    gs.splice(to, 0, g);
    this._build();
    this._emit();
  }

  _emit() {
    const cfg = { ...this._config };
    cfg.guests = cfg.guests.map((g) => {
      const o = {};
      Object.entries(g).forEach(([k, v]) => { if (!k.startsWith("_") && v !== "" && v !== undefined && v !== null && !(k === "collapsed" && v === false)) o[k] = v; });
      return o;
    });
    this._lastEmitted = JSON.stringify(cfg);
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: cfg }, bubbles: true, composed: true }));
  }

  _form(schema, data, onChange) {
    const f = document.createElement("ha-form");
    f.hass = this._hass;
    f.schema = schema;
    f.data = data;
    f.computeLabel = (s) => EDITOR_LABELS[s.name] || s.name;
    f.addEventListener("value-changed", (ev) => {
      ev.stopPropagation();
      onChange(ev.detail.value);
      f.data = ev.detail.value;
      this._emit();
    });
    return f;
  }

  _build() {
    const root = this.shadowRoot;
    root.querySelectorAll("details.guest").forEach((d, i) => {
      if (this._config.guests[i]) this._config.guests[i]._open = d.open;
    });
    root.innerHTML = `<style>
      :host { display: block; }
      .guest { border: 1px solid var(--divider-color); border-radius: 12px; margin: 12px 0; overflow: hidden; }
      .guest > summary { display: flex; align-items: center; gap: 8px; padding: 10px 14px; cursor: pointer;
        font-weight: 500; background: var(--secondary-background-color); list-style: none; }
      .guest > summary::-webkit-details-marker { display: none; }
      .guest > summary .t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .body { padding: 12px 14px 14px; }
      button { font: inherit; cursor: pointer; border-radius: 8px; padding: 6px 12px; border: 1px solid var(--divider-color);
        background: var(--card-background-color); color: var(--primary-text-color); }
      button.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: transparent; }
      button.del { color: var(--error-color, #db4437); }
      button.mv { padding: 2px 9px; }
      button.mv:disabled { opacity: .35; cursor: default; }
      .grip { cursor: grab; color: var(--secondary-text-color); font-size: 1.2rem; line-height: 1; padding: 0 4px; user-select: none; }
      .guest.over { outline: 2px dashed var(--primary-color); outline-offset: 2px; }
      .guest.dragging { opacity: .45; }
      .hint { color: var(--secondary-text-color); font-size: .85rem; margin: 8px 0 0; }
      h3 { margin: 18px 0 0; font-weight: 500; font-size: 1rem; }
    </style>`;

    root.appendChild(this._form(GENERAL_SCHEMA, {
      title: this._config.title ?? "Proxmox", discover: !!this._config.discover, compact: !!this._config.compact,
      show_actions: this._config.show_actions !== false, show_summary: this._config.show_summary !== false,
      collapsed_title: this._config.collapsed_title ?? "More guests", collapsed_open: !!this._config.collapsed_open,
    }, (v) => Object.assign(this._config, v)));

    const h = document.createElement("h3");
    h.textContent = "Guests";
    root.appendChild(h);
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Add one entry per VM or container and pick its entities. Only the name is required; leave anything you don't have empty.";
    root.appendChild(hint);

    this._config.guests.forEach((g, i) => {
      const d = document.createElement("details");
      d.className = "guest";
      d.open = this._config.guests.length <= 2 || g._open;
      const sum = document.createElement("summary");
      const t = document.createElement("span");
      t.className = "t";
      const title = () => `${(g.type || "vm") === "lxc" ? "LXC" : "VM"} · ${g.name || "Unnamed guest"}`;
      t.textContent = title();
      const del = document.createElement("button");
      del.className = "del";
      del.textContent = "Remove";
      del.addEventListener("click", (e) => {
        e.preventDefault();
        this._config.guests.splice(i, 1);
        this._build();
        this._emit();
      });
      const mk = (label, title, to) => {
        const b = document.createElement("button");
        b.className = "mv";
        b.textContent = label;
        b.title = title;
        b.disabled = to < 0 || to >= this._config.guests.length;
        b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); this._move(i, to); });
        return b;
      };
      const grip = document.createElement("span");
      grip.className = "grip";
      grip.textContent = "⠿";
      grip.title = "Drag to reorder";
      grip.draggable = true;
      grip.addEventListener("dragstart", (e) => {
        this._dragIdx = i;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(i));
        e.dataTransfer.setDragImage(d, 20, 20);
        d.classList.add("dragging");
      });
      grip.addEventListener("dragend", () => {
        d.classList.remove("dragging");
        root.querySelectorAll(".over").forEach((x) => x.classList.remove("over"));
      });
      grip.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
      d.addEventListener("dragover", (e) => { if (this._dragIdx !== undefined) { e.preventDefault(); d.classList.add("over"); } });
      d.addEventListener("dragleave", (e) => { if (!d.contains(e.relatedTarget)) d.classList.remove("over"); });
      d.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = this._dragIdx;
        this._dragIdx = undefined;
        this._move(from, i);
      });
      sum.append(grip, t, mk("↑", "Move up", i - 1), mk("↓", "Move down", i + 1), del);
      const body = document.createElement("div");
      body.className = "body";
      body.appendChild(this._form(GUEST_SCHEMA, { type: "vm", ...g }, (v) => {
        Object.keys(g).forEach((k) => delete g[k]);
        Object.assign(g, v);
        t.textContent = title();
      }));
      d.append(sum, body);
      root.appendChild(d);
    });

    const add = document.createElement("button");
    add.className = "primary";
    add.textContent = "+ Add guest";
    add.addEventListener("click", () => {
      this._config.guests.push({ name: `Guest ${this._config.guests.length + 1}`, type: "vm", _open: true });
      this._build();
      this._emit();
    });
    root.appendChild(add);
  }
}

if (!customElements.get("proxmox-guests-card-editor")) {
  customElements.define("proxmox-guests-card-editor", ProxmoxGuestsCardEditor);
}

if (!customElements.get("proxmox-guests-card")) {
  customElements.define("proxmox-guests-card", ProxmoxGuestsCard);
}
window.customCards = window.customCards || [];
window.customCards.push({
  type: "proxmox-guests-card",
  name: "Proxmox Guests",
  description: "Status, resource usage and power controls for Proxmox VMs and LXC containers.",
  preview: false,
});
console.info(`%c PROXMOX-GUESTS-CARD %c ${PGC_VERSION} `, "background:#e57000;color:#fff;font-weight:700", "background:#333;color:#fff");
