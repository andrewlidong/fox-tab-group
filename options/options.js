/* global FTG */
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let statusTimer = null;
function showStatus(message, { error = false, ms = 2500 } = {}) {
  const bar = $("#status");
  bar.textContent = message;
  bar.hidden = false;
  bar.classList.toggle("error", error);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (bar.hidden = true), ms);
}

let settings = { ...FTG.DEFAULT_SETTINGS };

async function loadSettings() {
  const data = await browser.storage.local.get("settings");
  settings = { ...FTG.DEFAULT_SETTINGS, ...(data.settings || {}) };
  for (const input of $$("[data-setting]")) {
    const key = input.dataset.setting;
    if (input.type === "checkbox") input.checked = Boolean(settings[key]);
    else input.value = settings[key];
  }
}

async function persistSetting(input) {
  const key = input.dataset.setting;
  let value;
  if (input.type === "checkbox") value = input.checked;
  else if (input.type === "number") value = Math.max(Number(input.min) || 0, Number(input.value) || 0);
  else value = input.value;
  settings = { ...settings, [key]: value };
  await browser.storage.local.set({ settings });
  showStatus("Saved");
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts (Firefox lets extensions update their own shortcuts)
// ---------------------------------------------------------------------------

const KEY_NAMES = {
  " ": "Space",
  ",": "Comma",
  ".": "Period",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
  Delete: "Delete",
};

function shortcutFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push(navigator.platform.includes("Mac") ? "MacCtrl" : "Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.metaKey) mods.push("Command");
  if (e.shiftKey) mods.push("Shift");
  let key = null;
  if (/^F([1-9]|1[0-2])$/.test(e.key)) key = e.key;
  else if (KEY_NAMES[e.key]) key = KEY_NAMES[e.key];
  else if (/^[a-z0-9]$/i.test(e.key)) key = e.key.toUpperCase();
  else if (e.code && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (e.code && /^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  if (!key) return { error: "That key can't be used in a shortcut." };
  const isFunctionKey = /^F\d+$/.test(key);
  const hasPrimary = mods.some((m) => m !== "Shift");
  if (!isFunctionKey && !hasPrimary) return { error: "Include Ctrl or Alt (or ⌘ on macOS)." };
  if (mods.filter((m) => m !== "Shift").length > 1) return { error: "Use only one of Ctrl, Alt or ⌘." };
  return { shortcut: [...mods, key].join("+") };
}

async function renderShortcuts() {
  const host = $("#shortcuts");
  const commands = await browser.commands.getAll();
  host.replaceChildren();
  for (const command of commands) {
    const row = document.createElement("div");
    row.className = "shortcut-row";
    const label = document.createElement("div");
    label.innerHTML = `<div class="desc"></div><div class="name"></div>`;
    label.querySelector(".desc").textContent =
      command.name === "_execute_action" ? "Open the Fox Tab Groups popup" : command.description || command.name;
    label.querySelector(".name").textContent = command.name;
    const input = document.createElement("input");
    input.type = "text";
    input.readOnly = true;
    input.value = command.shortcut || "";
    input.placeholder = "Not set";
    input.title = "Click, then press a key combination. Backspace clears.";
    const clear = document.createElement("button");
    clear.className = "icon-btn";
    clear.title = "Reset to default";
    clear.textContent = "↺";
    const err = document.createElement("div");
    err.className = "err";

    input.addEventListener("focus", () => input.classList.add("recording"));
    input.addEventListener("blur", () => input.classList.remove("recording"));
    input.addEventListener("keydown", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
      err.textContent = "";
      if (e.key === "Backspace" || e.key === "Escape" && !input.value) {
        try {
          await browser.commands.update({ name: command.name, shortcut: "" });
          input.value = "";
          showStatus("Shortcut cleared");
        } catch (ex) {
          err.textContent = ex.message;
        }
        return;
      }
      if (e.key === "Escape") return input.blur();
      const parsed = shortcutFromEvent(e);
      if (parsed.error) {
        err.textContent = parsed.error;
        return;
      }
      try {
        await browser.commands.update({ name: command.name, shortcut: parsed.shortcut });
        input.value = parsed.shortcut;
        showStatus(`Shortcut set to ${parsed.shortcut}`);
        input.blur();
      } catch (ex) {
        err.textContent = ex.message || "Firefox rejected that shortcut.";
      }
    });
    clear.addEventListener("click", async () => {
      try {
        await browser.commands.reset(command.name);
        await renderShortcuts();
        showStatus("Shortcut reset");
      } catch (ex) {
        err.textContent = ex.message;
      }
    });
    row.append(label, input, clear, err);
    host.append(row);
  }
}

// ---------------------------------------------------------------------------
// Data import / export
// ---------------------------------------------------------------------------

async function updateSummary() {
  const data = await browser.storage.local.get(["rules", "snapshots"]);
  const rules = Array.isArray(data.rules) ? data.rules.length : 0;
  const snaps = Array.isArray(data.snapshots) ? data.snapshots : [];
  const tabs = snaps.reduce((n, s) => n + FTG.countSnapshotTabs(s), 0);
  $("#data-summary").textContent = `${rules} rule${rules === 1 ? "" : "s"}, ${snaps.length} snapshot${snaps.length === 1 ? "" : "s"} (${tabs} saved tab${tabs === 1 ? "" : "s"}).`;
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function exportAll() {
  const data = await browser.storage.local.get(["rules", "snapshots", "settings"]);
  downloadJson(`fox-tab-groups-backup-${new Date().toISOString().slice(0, 10)}.json`, {
    exportedAt: new Date().toISOString(),
    rules: data.rules || [],
    snapshots: data.snapshots || [],
    settings: data.settings || {},
  });
}

async function importFile(file) {
  if (!file) return;
  const parsed = FTG.parseImportPayload(await file.text());
  if (parsed.error) return showStatus(parsed.error, { error: true, ms: 5000 });
  const data = await browser.storage.local.get(["rules", "snapshots"]);
  const rules = Array.isArray(data.rules) ? data.rules : [];
  const snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
  const ruleIds = new Set(rules.map((r) => r.id));
  const mergedRules = rules.map((r) => parsed.rules.find((p) => p.id === r.id) || r);
  for (const rule of parsed.rules) if (!ruleIds.has(rule.id)) mergedRules.push(rule);
  const snapIds = new Set(snapshots.map((s) => s.id));
  const mergedSnaps = snapshots.map((s) => parsed.snapshots.find((p) => p.id === s.id) || s);
  for (const snap of parsed.snapshots) if (!snapIds.has(snap.id)) mergedSnaps.unshift(snap);
  const patch = { rules: mergedRules, snapshots: mergedSnaps };
  if (parsed.settings) {
    const allowed = {};
    for (const key of Object.keys(FTG.DEFAULT_SETTINGS)) if (key in parsed.settings) allowed[key] = parsed.settings[key];
    patch.settings = { ...settings, ...allowed };
  }
  await browser.storage.local.set(patch);
  await loadSettings();
  await updateSummary();
  showStatus(`Imported ${parsed.rules.length} rule(s) and ${parsed.snapshots.length} snapshot(s)`);
}

async function resetAll() {
  if (!window.confirm("Delete every rule and snapshot? Settings are kept. This cannot be undone.")) return;
  await browser.storage.local.set({ rules: [], snapshots: [] });
  await updateSummary();
  showStatus("Rules and snapshots deleted");
}

// ---------------------------------------------------------------------------

async function init() {
  const colorSelect = $('[data-setting="defaultColor"]');
  for (const color of FTG.COLORS) {
    const opt = document.createElement("option");
    opt.value = color;
    opt.textContent = color;
    colorSelect.append(opt);
  }
  await loadSettings();
  for (const input of $$("[data-setting]")) input.addEventListener("change", () => persistSetting(input));

  $("#open-manager").addEventListener("click", () =>
    browser.tabs.create({ url: browser.runtime.getURL("popup/popup.html?mode=tab") })
  );
  $("#reset-shortcuts").addEventListener("click", async () => {
    const commands = await browser.commands.getAll();
    for (const c of commands) await browser.commands.reset(c.name).catch(() => {});
    await renderShortcuts();
    showStatus("Shortcuts reset to defaults");
  });
  $("#export-all").addEventListener("click", exportAll);
  $("#import-all").addEventListener("click", () => {
    const input = $("#file-input");
    input.value = "";
    input.click();
  });
  $("#file-input").addEventListener("change", (e) => importFile(e.target.files[0]));
  $("#reset-all").addEventListener("click", resetAll);

  await renderShortcuts();
  await updateSummary();
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local") updateSummary();
  });
}

init().catch((e) => showStatus(`Failed to load settings: ${e.message}`, { error: true, ms: 10000 }));
