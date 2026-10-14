/* global FTG */
"use strict";

// ---------------------------------------------------------------------------
// Tiny DOM helpers
// ---------------------------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style") node.style.cssText = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key in node && key !== "list") node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

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

async function send(type, payload = {}) {
  const response = await browser.runtime.sendMessage({ type, ...payload });
  if (!response) throw new Error("No response from background script");
  if (!response.ok) throw new Error(response.error || "Unknown error");
  return response.result;
}

async function guard(fn, okMessage) {
  try {
    const result = await fn();
    if (okMessage) showStatus(typeof okMessage === "function" ? okMessage(result) : okMessage);
    return result;
  } catch (e) {
    console.error(e);
    showStatus(e.message || String(e), { error: true, ms: 5000 });
    return undefined;
  }
}

function colorHex(color) {
  return FTG.COLOR_HEX[color] || FTG.COLOR_HEX.grey;
}

function formatDate(ts) {
  try {
    return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch (e) {
    return new Date(ts).toLocaleString();
  }
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Replace a text node with an inline <input>; calls onCommit(newValue). */
function inlineEdit(span, currentValue, onCommit, { placeholder = "" } = {}) {
  const input = el("input", { class: "title-input", value: currentValue, placeholder });
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    input.replaceWith(span);
    if (commit && value !== currentValue) onCommit(value);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
    e.stopPropagation();
  });
  input.addEventListener("blur", () => finish(true));
  span.replaceWith(input);
  input.focus();
  input.select();
}

let openMenu = null;
function closeMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
  }
}
/** items: [{label, onClick, danger?, separator?}] */
function showMenu(anchor, items) {
  closeMenu();
  const menu = el("div", { class: "menu" });
  for (const item of items) {
    if (item.separator) {
      menu.append(el("hr", { style: "border:0;border-top:1px solid var(--border);margin:4px 0" }));
      continue;
    }
    menu.append(
      el(
        "button",
        {
          class: item.danger ? "danger" : "",
          onclick: () => {
            closeMenu();
            item.onClick();
          },
        },
        item.label
      )
    );
  }
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let top = rect.bottom + 4;
  if (top + menuRect.height > window.innerHeight - 8) top = Math.max(8, rect.top - menuRect.height - 4);
  let left = rect.right - menuRect.width;
  if (left < 8) left = 8;
  menu.style.position = "fixed";
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  menu.style.right = "auto";
  menu.style.marginTop = "0";
  openMenu = menu;
}
document.addEventListener("click", (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
  const more = $("#groups-more");
  if (!more.hidden && !more.contains(e.target) && !e.target.closest('[data-action="more-groups"]')) more.hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeMenu();
    $("#groups-more").hidden = true;
  }
});

function paletteEl(selected, onPick) {
  const palette = el("div", { class: "palette" });
  for (const color of FTG.COLORS) {
    palette.append(
      el("button", {
        type: "button",
        class: `color-dot${color === selected ? " selected" : ""}`,
        title: color,
        style: `--group-color:${colorHex(color)}`,
        onclick: (e) => {
          e.stopPropagation();
          onPick(color);
        },
      })
    );
  }
  return palette;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  view: "groups",
  tabMode: false,
  settings: { ...FTG.DEFAULT_SETTINGS },
  rules: [],
  snapshots: [],
  currentWindowId: null,
  expandedSnapshots: new Set(),
  openPalettes: new Set(),
  editingRuleId: null,
};

async function loadStorage() {
  const data = await browser.storage.local.get(["rules", "settings", "snapshots"]);
  state.rules = Array.isArray(data.rules) ? data.rules : [];
  state.snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
  state.settings = { ...FTG.DEFAULT_SETTINGS, ...(data.settings || {}) };
}

async function saveRules(rules) {
  state.rules = rules;
  await browser.storage.local.set({ rules });
}
async function saveSnapshots(snapshots) {
  state.snapshots = snapshots;
  await browser.storage.local.set({ snapshots });
}
async function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  await browser.storage.local.set({ settings: state.settings });
}

// ---------------------------------------------------------------------------
// Views / navigation
// ---------------------------------------------------------------------------

function setView(view) {
  state.view = view;
  try {
    localStorage.setItem("ftg.view", view);
  } catch (e) {
    /* ignore */
  }
  for (const btn of $$(".tab")) btn.classList.toggle("active", btn.dataset.view === view);
  for (const section of $$(".view")) section.hidden = section.id !== `view-${view}`;
  closeMenu();
  render();
}

function render() {
  if (state.view === "groups") renderGroups();
  else if (state.view === "snapshots") renderSnapshots();
  else renderRules();
}

// ---------------------------------------------------------------------------
// Groups view
// ---------------------------------------------------------------------------

let renderTimer = null;
function scheduleRender() {
  if (state.view !== "groups") return;
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    // Don't yank the DOM out from under an in-progress inline edit.
    const active = document.activeElement;
    if (active && active.classList.contains("title-input") && $("#groups-list").contains(active)) {
      scheduleRender();
      return;
    }
    renderGroups();
  }, 120);
}

function matchesFilter(tab, filter) {
  if (!filter) return true;
  const f = filter.toLowerCase();
  return (tab.title || "").toLowerCase().includes(f) || (tab.url || "").toLowerCase().includes(f);
}

async function renderGroups() {
  const list = $("#groups-list");
  const filter = $("#groups-filter").value.trim();
  $("#show-all-windows").checked = Boolean(state.settings.showAllWindows);

  const windows = await browser.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const groups = await browser.tabGroups.query({});
  const groupsById = new Map(groups.map((g) => [g.id, g]));

  windows.sort((a, b) => (a.id === state.currentWindowId ? -1 : b.id === state.currentWindowId ? 1 : 0));
  const visibleWindows = state.settings.showAllWindows ? windows : windows.filter((w) => w.id === state.currentWindowId);

  const frag = document.createDocumentFragment();
  let anything = false;

  visibleWindows.forEach((win, wIndex) => {
    const tabs = (win.tabs || []).slice().sort((a, b) => a.index - b.index);
    const ordered = [];
    const seen = new Set();
    for (const tab of tabs) {
      if (tab.groupId !== FTG.NO_GROUP && !seen.has(tab.groupId)) {
        seen.add(tab.groupId);
        ordered.push(tab.groupId);
      }
    }
    const ungrouped = tabs.filter((t) => t.groupId === FTG.NO_GROUP && matchesFilter(t, filter));

    if (state.settings.showAllWindows) {
      frag.append(
        el(
          "div",
          { class: "window-head" },
          el("span", {}, win.id === state.currentWindowId ? "This window" : `Window ${wIndex + 1}`),
          el("span", {}, `${tabs.length} tabs · ${ordered.length} groups`)
        )
      );
    }

    for (const groupId of ordered) {
      const group = groupsById.get(groupId);
      if (!group) continue;
      const groupTabs = tabs.filter((t) => t.groupId === groupId && matchesFilter(t, filter));
      if (filter && !groupTabs.length) continue;
      anything = true;
      frag.append(groupCard(group, groupTabs, tabs.filter((t) => t.groupId === groupId).length, windows, Boolean(filter)));
    }

    if (ungrouped.length) {
      anything = true;
      frag.append(ungroupedCard(win, ungrouped, groups.filter((g) => g.windowId === win.id)));
    }
  });

  if (!anything) {
    frag.append(el("div", { class: "empty" }, filter ? "No tabs match that filter." : "No tabs here yet."));
  }
  list.replaceChildren(frag);
}

function groupCard(group, tabs, totalCount, windows, filtering) {
  const collapsed = group.collapsed && !filtering;
  const card = el("div", {
    class: `card group${collapsed ? " collapsed" : ""}`,
    style: `--group-color:${colorHex(group.color)}`,
    dataset: { groupId: String(group.id) },
  });

  const titleSpan = el(
    "span",
    { class: `title${group.title ? "" : " untitled"}`, title: "Click to rename" },
    group.title || "Untitled group"
  );
  titleSpan.addEventListener("click", () => {
    inlineEdit(titleSpan, group.title || "", (value) => guard(() => browser.tabGroups.update(group.id, { title: value })), {
      placeholder: "Group name",
    });
  });

  const dot = el("button", { class: "color-dot", title: "Change colour" });
  dot.addEventListener("click", (e) => {
    e.stopPropagation();
    if (state.openPalettes.has(group.id)) state.openPalettes.delete(group.id);
    else state.openPalettes.add(group.id);
    renderGroups();
  });

  const collapseBtn = el(
    "button",
    { class: "icon-btn", title: group.collapsed ? "Expand group" : "Collapse group" },
    group.collapsed ? "▸" : "▾"
  );
  collapseBtn.addEventListener("click", () =>
    guard(async () => {
      const ok = await send("setGroupCollapsed", { groupId: group.id, collapsed: !group.collapsed });
      if (ok === false) showStatus("Can't collapse the only group in a window while it holds the active tab.", { error: true });
    })
  );

  const moreBtn = el("button", { class: "icon-btn", title: "Group actions" }, "⋯");
  moreBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const otherWindows = windows.filter((w) => w.id !== group.windowId);
    const items = [
      { label: "New tab in group", onClick: () => guard(() => send("newTabInGroup", { groupId: group.id })) },
      {
        label: "Save group as snapshot",
        onClick: () => guard(() => send("saveGroupSnapshot", { groupId: group.id }), "Snapshot saved"),
      },
      { separator: true },
      { label: "Move to new window", onClick: () => guard(() => send("moveGroupToNewWindow", { groupId: group.id })) },
      ...otherWindows.map((w, i) => ({
        label: `Move to window ${windows.indexOf(w) + 1}${w.id === state.currentWindowId ? " (this window)" : ""}`,
        onClick: () => guard(() => send("moveGroupToWindow", { groupId: group.id, windowId: w.id })),
      })),
      { separator: true },
      { label: "Ungroup tabs", onClick: () => guard(() => send("ungroupGroup", { groupId: group.id })) },
      {
        label: `Close group (${totalCount} tab${totalCount === 1 ? "" : "s"})`,
        danger: true,
        onClick: () => guard(() => send("closeGroup", { groupId: group.id })),
      },
    ];
    showMenu(moreBtn, items);
  });

  const head = el(
    "div",
    { class: "group-head" },
    dot,
    titleSpan,
    el("span", { class: "count" }, String(totalCount)),
    el("div", { class: "actions" }, collapseBtn, moreBtn)
  );
  card.append(head);

  if (state.openPalettes.has(group.id)) {
    card.append(
      paletteEl(group.color, (color) => {
        state.openPalettes.delete(group.id);
        guard(() => browser.tabGroups.update(group.id, { color }));
      })
    );
  }

  if (collapsed) {
    card.append(el("div", { class: "collapsed-note" }, `${totalCount} tab${totalCount === 1 ? "" : "s"} hidden`));
  } else {
    for (const tab of tabs) card.append(tabRow(tab, windows));
  }
  return card;
}

function ungroupedCard(win, tabs, windowGroups) {
  const card = el("div", { class: "card ungrouped" });
  const groupAllBtn = el("button", { class: "icon-btn", title: "Group these tabs by domain" }, "⊞");
  groupAllBtn.addEventListener("click", () =>
    guard(() => send("autoGroupByDomain", { windowId: win.id }), (n) => `Grouped into ${n} group${n === 1 ? "" : "s"}`)
  );
  card.append(
    el(
      "div",
      { class: "group-head" },
      el("span", { class: "title untitled", style: "cursor:default" }, "Ungrouped tabs"),
      el("span", { class: "count" }, String(tabs.length)),
      el("div", { class: "actions" }, groupAllBtn)
    )
  );
  for (const tab of tabs) card.append(tabRow(tab, null, windowGroups));
  return card;
}

function tabRow(tab, windows, windowGroups) {
  const row = el("div", {
    class: `tab-row${tab.active ? " active" : ""}${tab.pinned ? " pinned" : ""}`,
    title: tab.url || "",
    tabIndex: 0,
  });
  const favicon =
    tab.favIconUrl && /^(https?|data):/.test(tab.favIconUrl)
      ? el("img", { class: "favicon", src: tab.favIconUrl, alt: "" })
      : el("span", { class: "favicon-fallback" });
  if (favicon.tagName === "IMG") favicon.addEventListener("error", () => favicon.replaceWith(el("span", { class: "favicon-fallback" })));

  const activate = () =>
    guard(async () => {
      await browser.tabs.update(tab.id, { active: true });
      await browser.windows.update(tab.windowId, { focused: true });
      if (!state.tabMode) window.close();
    });
  row.addEventListener("click", activate);
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter") activate();
  });

  const moveBtn = el("button", { class: "icon-btn", title: "Move to group…" }, "⇢");
  moveBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const groups = windowGroups || (await browser.tabGroups.query({ windowId: tab.windowId }));
    const items = [
      {
        label: "New group",
        onClick: () =>
          guard(async () => {
            const gid = await browser.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
            await browser.tabGroups.update(gid, { title: FTG.domainLabel(tab.url) || "", color: state.settings.defaultColor });
          }),
      },
      ...groups
        .filter((g) => g.id !== tab.groupId)
        .map((g) => ({
          label: `→ ${g.title || "Untitled group"}`,
          onClick: () => guard(() => browser.tabs.group({ tabIds: [tab.id], groupId: g.id })),
        })),
    ];
    if (tab.groupId !== FTG.NO_GROUP) {
      items.push({ separator: true }, { label: "Remove from group", onClick: () => guard(() => browser.tabs.ungroup([tab.id])) });
    }
    showMenu(moveBtn, items);
  });

  const closeBtn = el("button", { class: "icon-btn danger", title: "Close tab" }, "✕");
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    guard(() => browser.tabs.remove(tab.id));
  });

  row.append(
    favicon,
    el("span", { class: `tab-title${tab.discarded ? " discarded" : ""}` }, tab.title || tab.url || "(untitled)"),
    el("div", { class: "row-actions" }, moveBtn, closeBtn)
  );
  return row;
}

// ---------------------------------------------------------------------------
// Snapshots view
// ---------------------------------------------------------------------------

function renderSnapshots() {
  const list = $("#snapshots-list");
  const filter = $("#snapshots-filter").value.trim().toLowerCase();
  const frag = document.createDocumentFragment();
  const snapshots = state.snapshots.filter((s) => {
    if (!filter) return true;
    if (s.name.toLowerCase().includes(filter)) return true;
    return s.groups.some(
      (g) => (g.title || "").toLowerCase().includes(filter) || g.tabs.some((t) => (t.title || t.url).toLowerCase().includes(filter))
    );
  });
  if (!snapshots.length) {
    frag.append(
      el(
        "div",
        { class: "empty" },
        filter ? "No snapshots match that filter." : "No snapshots yet. Save the current window or a single group to restore it later."
      )
    );
  }
  for (const snapshot of snapshots) frag.append(snapshotCard(snapshot));
  list.replaceChildren(frag);
}

async function updateSnapshot(id, updater) {
  const snapshots = state.snapshots.map((s) => (s.id === id ? { ...updater(structuredClone(s)), updatedAt: Date.now() } : s));
  await saveSnapshots(snapshots);
  renderSnapshots();
}

function snapshotCard(snapshot) {
  const expanded = state.expandedSnapshots.has(snapshot.id);
  const tabCount = FTG.countSnapshotTabs(snapshot);
  const card = el("div", { class: "card snapshot" });

  const titleSpan = el("span", { class: "title", title: "Click to rename" }, snapshot.name);
  titleSpan.addEventListener("click", () =>
    inlineEdit(titleSpan, snapshot.name, (value) => value && updateSnapshot(snapshot.id, (s) => ({ ...s, name: value })))
  );

  const toggle = el("button", { class: "icon-btn", title: expanded ? "Hide contents" : "Show contents" }, expanded ? "▾" : "▸");
  toggle.addEventListener("click", () => {
    if (expanded) state.expandedSnapshots.delete(snapshot.id);
    else state.expandedSnapshots.add(snapshot.id);
    renderSnapshots();
  });

  const restore = (options, label) =>
    guard(
      () => send("restoreSnapshot", { snapshotId: snapshot.id, options }),
      (r) => `${label}: ${r.restored} tab${r.restored === 1 ? "" : "s"} restored${r.skipped ? `, ${r.skipped} skipped` : ""}`
    );

  const moreBtn = el("button", { class: "icon-btn", title: "Snapshot actions" }, "⋯");
  moreBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    showMenu(moreBtn, [
      { label: "Restore in this window", onClick: () => restore({ inNewWindow: false }, "Restored") },
      { label: "Restore in a new window", onClick: () => restore({ inNewWindow: true }, "Restored") },
      { separator: true },
      {
        label: "Update from current window",
        onClick: () =>
          guard(async () => {
            const fresh = await send("captureWindow", { windowId: state.currentWindowId });
            await updateSnapshot(snapshot.id, (s) => ({ ...s, groups: fresh.groups, ungrouped: fresh.ungrouped }));
          }, "Snapshot updated from this window"),
      },
      {
        label: "Merge groups with the same name",
        onClick: () =>
          guard(async () => {
            const before = snapshot.groups.length;
            await updateSnapshot(snapshot.id, (s) => FTG.mergeSameNameGroups(s));
            const after = state.snapshots.find((s) => s.id === snapshot.id).groups.length;
            showStatus(`Merged ${before - after} group${before - after === 1 ? "" : "s"}`);
          }),
      },
      { label: "Export this snapshot", onClick: () => downloadJson(`${snapshot.name.replace(/[^\w.-]+/g, "_")}.json`, { snapshots: [snapshot] }) },
      { separator: true },
      {
        label: "Delete snapshot",
        danger: true,
        onClick: () => guard(() => saveSnapshots(state.snapshots.filter((s) => s.id !== snapshot.id)).then(renderSnapshots), "Snapshot deleted"),
      },
    ]);
  });

  const restoreBtn = el("button", { class: "btn primary", title: "Restore all tabs and groups" }, "Restore");
  restoreBtn.addEventListener("click", () => restore({}, "Restored"));

  card.append(
    el(
      "div",
      { class: "snap-head" },
      toggle,
      el(
        "div",
        { class: "snap-title-block" },
        titleSpan,
        el("span", { class: "meta" }, `${snapshot.groups.length} group${snapshot.groups.length === 1 ? "" : "s"} · ${tabCount} tab${tabCount === 1 ? "" : "s"} · ${formatDate(snapshot.createdAt)}`)
      ),
      restoreBtn,
      moreBtn
    )
  );

  if (!expanded) return card;

  const body = el("div", { class: "snap-body" });
  snapshot.groups.forEach((group, gi) => {
    const gTitle = el("span", { class: `title${group.title ? "" : " untitled"}`, title: "Click to rename" }, group.title || "Untitled group");
    gTitle.addEventListener("click", () =>
      inlineEdit(gTitle, group.title || "", (value) =>
        updateSnapshot(snapshot.id, (s) => {
          s.groups[gi].title = value;
          return s;
        })
      )
    );
    const gDot = el("button", { class: "color-dot", title: "Change colour" });
    const gActions = el("div", { class: "row-actions", style: "opacity:1" });
    const restoreGroupBtn = el("button", { class: "icon-btn", title: "Restore only this group" }, "↩");
    restoreGroupBtn.addEventListener("click", () => restore({ groupIndex: gi, inNewWindow: false }, "Group restored"));
    const removeGroupBtn = el("button", { class: "icon-btn danger", title: "Remove group from snapshot" }, "✕");
    removeGroupBtn.addEventListener("click", () =>
      updateSnapshot(snapshot.id, (s) => {
        s.groups.splice(gi, 1);
        return s;
      })
    );
    gActions.append(restoreGroupBtn, removeGroupBtn);
    const gRow = el(
      "div",
      { class: "snap-group", style: `--group-color:${colorHex(group.color)}` },
      gDot,
      gTitle,
      el("span", { class: "count" }, String(group.tabs.length)),
      gActions
    );
    body.append(gRow);
    const paletteKey = `${snapshot.id}:${gi}`;
    gDot.addEventListener("click", () => {
      if (state.openPalettes.has(paletteKey)) state.openPalettes.delete(paletteKey);
      else state.openPalettes.add(paletteKey);
      renderSnapshots();
    });
    if (state.openPalettes.has(paletteKey)) {
      body.append(
        paletteEl(group.color, (color) => {
          state.openPalettes.delete(paletteKey);
          updateSnapshot(snapshot.id, (s) => {
            s.groups[gi].color = color;
            return s;
          });
        })
      );
    }
    const tabsEl = el("div", { class: "snap-tabs" });
    group.tabs.forEach((tab, ti) => tabsEl.append(snapshotTabRow(snapshot, tab, (s) => s.groups[gi].tabs, ti)));
    body.append(tabsEl);
  });

  if (snapshot.ungrouped && snapshot.ungrouped.length) {
    body.append(
      el(
        "div",
        { class: "snap-group", style: "--group-color:transparent" },
        el("span", { class: "title untitled", style: "cursor:default" }, "Ungrouped tabs"),
        el("span", { class: "count" }, String(snapshot.ungrouped.length))
      )
    );
    const tabsEl = el("div", { class: "snap-tabs" });
    snapshot.ungrouped.forEach((tab, ti) => tabsEl.append(snapshotTabRow(snapshot, tab, (s) => s.ungrouped, ti)));
    body.append(tabsEl);
  }
  card.append(body);
  return card;
}

function snapshotTabRow(snapshot, tab, listGetter, index) {
  const openBtn = el("button", { class: "icon-btn", title: "Open in a new tab" }, "↗");
  openBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!FTG.isRestorableUrl(tab.url)) return showStatus("Firefox doesn't allow extensions to open that URL.", { error: true });
    guard(() => browser.tabs.create({ url: tab.url, active: false }));
  });
  const removeBtn = el("button", { class: "icon-btn danger", title: "Remove from snapshot" }, "✕");
  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    updateSnapshot(snapshot.id, (s) => {
      listGetter(s).splice(index, 1);
      return s;
    });
  });
  return el(
    "div",
    { class: `snap-tab${tab.pinned ? " pinned" : ""}`, title: tab.url },
    el("span", { class: "tab-title" }, tab.title || tab.url),
    el("div", { class: "row-actions" }, openBtn, removeBtn)
  );
}

// ---------------------------------------------------------------------------
// Rules view
// ---------------------------------------------------------------------------

const PATTERN_HINTS = {
  domain: "One or more domains, separated by commas. “example.com” also matches its sub-domains; “*.example.com” matches sub-domains only.",
  "url-contains": "One or more text fragments, separated by commas. Matches when the tab URL contains any of them.",
  "url-regex": "A JavaScript regular expression tested against the full URL.",
  "title-contains": "One or more text fragments, separated by commas. Matches when the tab title contains any of them.",
  "title-regex": "A JavaScript regular expression tested against the tab title.",
};

function renderRules() {
  $("#auto-group-enabled").checked = Boolean(state.settings.autoGroupEnabled);
  const list = $("#rules-list");
  const frag = document.createDocumentFragment();
  if (!state.rules.length) {
    frag.append(
      el(
        "div",
        { class: "empty" },
        "No rules yet. Add a rule to automatically put matching tabs into a named, coloured group as they load."
      )
    );
  }
  state.rules.forEach((rule, index) => {
    const row = el("div", {
      class: `card rule-row${rule.enabled ? "" : " disabled"}`,
      style: `--group-color:${colorHex(rule.color)}`,
    });
    const toggle = el("input", { type: "checkbox", checked: rule.enabled, title: rule.enabled ? "Disable rule" : "Enable rule" });
    toggle.addEventListener("change", () =>
      saveRules(state.rules.map((r) => (r.id === rule.id ? { ...r, enabled: toggle.checked } : r))).then(renderRules)
    );
    const target = FTG.groupTitleForRule(rule, { url: "" });
    const main = el(
      "div",
      { class: "rule-main" },
      el("div", { class: "rule-name" }, rule.name || target),
      el("div", { class: "rule-pattern" }, `${FTG.MATCH_TYPES[rule.matchType]}: ${rule.pattern}`),
      el("div", { class: "rule-target" }, `→ ${target} · ${rule.color}${rule.caseSensitive ? " · case sensitive" : ""}`)
    );
    const up = el("button", { class: "icon-btn", title: "Move up (rules match in order)", disabled: index === 0 }, "↑");
    const down = el("button", { class: "icon-btn", title: "Move down", disabled: index === state.rules.length - 1 }, "↓");
    const move = (delta) => {
      const rules = state.rules.slice();
      const [item] = rules.splice(index, 1);
      rules.splice(index + delta, 0, item);
      saveRules(rules).then(renderRules);
    };
    up.addEventListener("click", () => move(-1));
    down.addEventListener("click", () => move(1));
    const edit = el("button", { class: "icon-btn", title: "Edit rule" }, "✎");
    edit.addEventListener("click", () => openRuleForm(rule));
    const del = el("button", { class: "icon-btn danger", title: "Delete rule" }, "✕");
    del.addEventListener("click", () => saveRules(state.rules.filter((r) => r.id !== rule.id)).then(renderRules));
    row.append(toggle, main, el("div", { class: "actions" }, up, down, edit, del));
    frag.append(row);
  });
  list.replaceChildren(frag);
}

function openRuleForm(rule) {
  const form = $("#rule-form");
  form.hidden = false;
  form.reset();
  const data = rule || { id: "", name: "", matchType: "domain", pattern: "", groupTitle: "", color: state.settings.defaultColor, enabled: true, caseSensitive: false };
  state.editingRuleId = data.id || null;
  form.elements.id.value = data.id || "";
  form.elements.name.value = data.name || "";
  form.elements.matchType.value = data.matchType;
  form.elements.pattern.value = data.pattern || "";
  form.elements.groupTitle.value = data.groupTitle || "";
  form.elements.color.value = data.color || "grey";
  form.elements.enabled.checked = data.enabled !== false;
  form.elements.caseSensitive.checked = Boolean(data.caseSensitive);
  $("[data-error]", form).textContent = "";
  updateRuleFormHints();
  form.elements.name.focus();
  form.scrollIntoView({ block: "nearest" });
}

function updateRuleFormHints() {
  const form = $("#rule-form");
  const type = form.elements.matchType.value;
  $("[data-hint]", form).textContent = PATTERN_HINTS[type] || "";
  form.elements.caseSensitive.closest("label").hidden = type === "domain";
  const paletteHost = $("[data-palette]", form);
  paletteHost.replaceChildren(
    ...paletteEl(form.elements.color.value, (color) => {
      form.elements.color.value = color;
      updateRuleFormHints();
    }).children
  );
}

function closeRuleForm() {
  $("#rule-form").hidden = true;
  state.editingRuleId = null;
}

async function submitRuleForm(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const errorEl = $("[data-error]", form);
  const raw = {
    id: form.elements.id.value || undefined,
    name: form.elements.name.value,
    matchType: form.elements.matchType.value,
    pattern: form.elements.pattern.value,
    groupTitle: form.elements.groupTitle.value,
    color: form.elements.color.value,
    enabled: form.elements.enabled.checked,
    caseSensitive: form.elements.caseSensitive.checked,
  };
  if (!raw.pattern.trim()) {
    errorEl.textContent = "A pattern is required.";
    return;
  }
  if (raw.matchType.endsWith("regex")) {
    const err = FTG.validateRegex(raw.pattern.trim());
    if (err) {
      errorEl.textContent = `Invalid regex: ${err}`;
      return;
    }
  }
  const rule = FTG.normalizeRule(raw);
  const exists = state.rules.some((r) => r.id === rule.id);
  const rules = exists ? state.rules.map((r) => (r.id === rule.id ? rule : r)) : [...state.rules, rule];
  await saveRules(rules);
  closeRuleForm();
  renderRules();
  showStatus(exists ? "Rule updated" : "Rule added");
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

let pendingImportKind = null;

function startImport(kind) {
  if (!state.tabMode) {
    // File pickers close the popup in Firefox; hand off to the full-page view.
    openInTab(`${state.view}`, { import: kind });
    return;
  }
  pendingImportKind = kind;
  const input = $("#file-input");
  input.value = "";
  input.click();
}

async function handleImportFile(file) {
  const kind = pendingImportKind;
  pendingImportKind = null;
  if (!file || !kind) return;
  const text = await file.text();
  const parsed = FTG.parseImportPayload(text);
  if (parsed.error) return showStatus(parsed.error, { error: true, ms: 5000 });
  if (kind === "rules") {
    if (!parsed.rules.length) return showStatus("That file contains no rules.", { error: true });
    const ids = new Set(state.rules.map((r) => r.id));
    const merged = state.rules.map((r) => parsed.rules.find((p) => p.id === r.id) || r);
    for (const rule of parsed.rules) if (!ids.has(rule.id)) merged.push(rule);
    await saveRules(merged);
    renderRules();
    showStatus(`Imported ${parsed.rules.length} rule${parsed.rules.length === 1 ? "" : "s"}`);
  } else {
    if (!parsed.snapshots.length) return showStatus("That file contains no snapshots.", { error: true });
    const ids = new Set(state.snapshots.map((s) => s.id));
    const merged = state.snapshots.map((s) => parsed.snapshots.find((p) => p.id === s.id) || s);
    for (const snap of parsed.snapshots) if (!ids.has(snap.id)) merged.unshift(snap);
    await saveSnapshots(merged);
    renderSnapshots();
    showStatus(`Imported ${parsed.snapshots.length} snapshot${parsed.snapshots.length === 1 ? "" : "s"}`);
  }
}

function openInTab(view, params = {}) {
  const url = new URL(browser.runtime.getURL("popup/popup.html"));
  url.searchParams.set("mode", "tab");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.hash = view || state.view;
  browser.tabs.create({ url: url.toString() }).then(() => {
    if (!state.tabMode) window.close();
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

async function init() {
  const params = new URLSearchParams(location.search);
  const current = await browser.tabs.getCurrent().catch(() => null);
  state.tabMode = params.get("mode") === "tab" || Boolean(current);
  document.body.classList.toggle("tab-mode", state.tabMode);
  $("#open-in-tab").hidden = state.tabMode;

  const win = await browser.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  state.currentWindowId = current ? current.windowId : win ? win.id : null;

  await loadStorage();

  // Match type options.
  const select = $('#rule-form select[name="matchType"]');
  for (const [value, label] of Object.entries(FTG.MATCH_TYPES)) select.append(el("option", { value }, label));
  select.addEventListener("change", updateRuleFormHints);

  // Navigation.
  for (const btn of $$(".tab")) btn.addEventListener("click", () => setView(btn.dataset.view));
  $("#open-in-tab").addEventListener("click", () => openInTab(state.view));
  $("#open-options").addEventListener("click", () => browser.runtime.openOptionsPage());

  // Groups toolbar.
  $("#groups-filter").addEventListener("input", renderGroups);
  $("#snapshots-filter").addEventListener("input", renderSnapshots);
  for (const btn of $$('[data-action="save-window"]')) {
    btn.addEventListener("click", () =>
      guard(() => send("saveWindowSnapshot", { windowId: state.currentWindowId }), "Window snapshot saved").then(() => {
        if (state.view === "snapshots") renderSnapshots();
      })
    );
  }
  $('[data-action="auto-domain"]').addEventListener("click", () =>
    guard(() => send("autoGroupByDomain", { windowId: state.currentWindowId }), (n) => `Grouped into ${n} group${n === 1 ? "" : "s"}`)
  );
  $('[data-action="apply-rules"]').addEventListener("click", () =>
    guard(() => send("applyRules", { windowId: state.currentWindowId }), (n) => `${n} tab${n === 1 ? "" : "s"} moved`)
  );
  $('[data-action="more-groups"]').addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("#groups-more");
    menu.hidden = !menu.hidden;
  });
  $('[data-action="collapse-all"]').addEventListener("click", () => {
    $("#groups-more").hidden = true;
    guard(() => send("setAllCollapsed", { windowId: state.currentWindowId, collapsed: true }));
  });
  $('[data-action="expand-all"]').addEventListener("click", () => {
    $("#groups-more").hidden = true;
    guard(() => send("setAllCollapsed", { windowId: state.currentWindowId, collapsed: false }));
  });
  $('[data-action="merge-open"]').addEventListener("click", () => {
    $("#groups-more").hidden = true;
    guard(() => send("mergeOpenGroups", { windowId: state.currentWindowId }), (n) => `Merged ${n} group${n === 1 ? "" : "s"}`);
  });
  $("#show-all-windows").addEventListener("change", (e) => saveSettings({ showAllWindows: e.target.checked }).then(renderGroups));

  // Snapshots toolbar.
  $('[data-action="export-snapshots"]').addEventListener("click", () => {
    if (!state.snapshots.length) return showStatus("Nothing to export yet.", { error: true });
    downloadJson(`fox-tab-groups-snapshots-${new Date().toISOString().slice(0, 10)}.json`, { snapshots: state.snapshots });
  });
  $('[data-action="import-snapshots"]').addEventListener("click", () => startImport("snapshots"));

  // Rules toolbar + form.
  $("#auto-group-enabled").addEventListener("change", (e) =>
    saveSettings({ autoGroupEnabled: e.target.checked }).then(() => showStatus(e.target.checked ? "Auto-grouping on" : "Auto-grouping off"))
  );
  $('[data-action="new-rule"]').addEventListener("click", () => openRuleForm(null));
  $('[data-action="cancel-rule"]').addEventListener("click", closeRuleForm);
  $("#rule-form").addEventListener("submit", submitRuleForm);
  $('[data-action="export-rules"]').addEventListener("click", () => {
    if (!state.rules.length) return showStatus("Nothing to export yet.", { error: true });
    downloadJson(`fox-tab-groups-rules-${new Date().toISOString().slice(0, 10)}.json`, { rules: state.rules });
  });
  $('[data-action="import-rules"]').addEventListener("click", () => startImport("rules"));
  $("#file-input").addEventListener("change", (e) => handleImportFile(e.target.files[0]));

  // Live updates.
  const tabEvents = ["onCreated", "onUpdated", "onRemoved", "onMoved", "onActivated", "onAttached", "onDetached"];
  for (const name of tabEvents) browser.tabs[name].addListener(scheduleRender);
  for (const name of ["onCreated", "onUpdated", "onRemoved", "onMoved"]) browser.tabGroups[name].addListener(scheduleRender);
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    loadStorage().then(() => {
      if (state.view !== "groups") render();
    });
  });

  // Initial view: ?import=… / #hash / remembered.
  let view = (location.hash || "").replace("#", "");
  if (!["groups", "snapshots", "rules"].includes(view)) {
    try {
      view = localStorage.getItem("ftg.view") || "groups";
    } catch (e) {
      view = "groups";
    }
  }
  setView(view);
  const importKind = params.get("import");
  if (importKind && state.tabMode) {
    showStatus(`Click “Import” to choose a ${importKind} JSON file.`, { ms: 6000 });
  }
}

init().catch((e) => {
  console.error(e);
  showStatus(`Failed to start: ${e.message}`, { error: true, ms: 10000 });
});
