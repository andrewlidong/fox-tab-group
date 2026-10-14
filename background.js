/* global FTG */
"use strict";

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function loadState() {
  const data = await browser.storage.local.get(["rules", "settings", "snapshots"]);
  return {
    rules: Array.isArray(data.rules) ? data.rules : [],
    snapshots: Array.isArray(data.snapshots) ? data.snapshots : [],
    settings: { ...FTG.DEFAULT_SETTINGS, ...(data.settings || {}) },
  };
}

async function saveSnapshots(snapshots) {
  await browser.storage.local.set({ snapshots });
}

function isGrouped(tab) {
  return typeof tab.groupId === "number" && tab.groupId !== FTG.NO_GROUP;
}

function isGroupableUrl(url) {
  return Boolean(url) && url !== "about:blank" && url !== "about:newtab" && url !== "about:home";
}

async function getActiveTab(windowId) {
  const query = windowId == null ? { active: true, currentWindow: true } : { active: true, windowId };
  const [tab] = await browser.tabs.query(query);
  return tab || null;
}

async function getSelectedTabs(windowId) {
  const query = windowId == null ? { highlighted: true, currentWindow: true } : { highlighted: true, windowId };
  return browser.tabs.query(query);
}

// ---------------------------------------------------------------------------
// Grouping primitives
// ---------------------------------------------------------------------------

/**
 * Serialises "find or create the group titled X in window W" so that several
 * tabs loading at the same time end up in one group instead of one each.
 */
const pendingGroups = new Map();

async function addTabsToTitledGroup(tabs, windowId, title, color, collapsed) {
  if (!tabs.length) return null;
  const key = `${windowId}\u0000${title}`;
  let pending = pendingGroups.get(key);
  if (!pending) {
    pending = (async () => {
      const [existing] = await browser.tabGroups.query({ windowId, title });
      if (existing) return existing.id;
      const groupId = await browser.tabs.group({
        tabIds: tabs.map((t) => t.id),
        createProperties: { windowId },
      });
      const props = { title };
      if (FTG.isColor(color)) props.color = color;
      if (typeof collapsed === "boolean") props.collapsed = collapsed;
      await browser.tabGroups.update(groupId, props);
      return groupId;
    })();
    pendingGroups.set(key, pending);
    pending.finally(() => pendingGroups.delete(key));
  }
  const groupId = await pending;
  const fresh = await Promise.all(tabs.map((t) => browser.tabs.get(t.id).catch(() => null)));
  const toMove = fresh.filter((t) => t && t.groupId !== groupId).map((t) => t.id);
  if (toMove.length) {
    await browser.tabs.group({ tabIds: toMove, groupId });
  }
  return groupId;
}

async function createGroup(tabIds, windowId, props) {
  const groupId = await browser.tabs.group({ tabIds, createProperties: { windowId } });
  if (props && Object.keys(props).length) await browser.tabGroups.update(groupId, props);
  return groupId;
}

async function groupTabs(groupId) {
  return browser.tabs.query({ groupId });
}

// ---------------------------------------------------------------------------
// Rule-based auto grouping
// ---------------------------------------------------------------------------

async function applyRulesToTab(tab, state) {
  if (!state) state = await loadState();
  const { rules, settings } = state;
  if (!rules.length) return false;
  if (settings.skipPinnedTabs && tab.pinned) return false;
  if (!isGroupableUrl(tab.url)) return false;

  const rule = FTG.findMatchingRule(rules, tab);
  if (rule) {
    const title = FTG.groupTitleForRule(rule, tab);
    if (isGrouped(tab)) {
      const current = await browser.tabGroups.get(tab.groupId).catch(() => null);
      if (current && current.title === title) return false;
    }
    await addTabsToTitledGroup([tab], tab.windowId, title, rule.color || settings.defaultColor);
    return true;
  }

  if (settings.ungroupWhenNoRuleMatches && isGrouped(tab)) {
    // Only pull tabs out of groups that look rule-managed, never user-made ones.
    const current = await browser.tabGroups.get(tab.groupId).catch(() => null);
    const managedTitles = new Set(rules.map((r) => FTG.groupTitleForRule(r, tab)));
    if (current && managedTitles.has(current.title)) {
      await browser.tabs.ungroup([tab.id]);
      return true;
    }
  }
  return false;
}

async function applyRulesToWindow(windowId) {
  const state = await loadState();
  const tabs = await browser.tabs.query(windowId == null ? { currentWindow: true } : { windowId });
  let changed = 0;
  for (const tab of tabs) {
    try {
      if (await applyRulesToTab(tab, state)) changed += 1;
    } catch (e) {
      console.warn("applyRules failed for tab", tab.id, e);
    }
  }
  return changed;
}

async function autoGroupByDomain(windowId) {
  const { settings } = await loadState();
  const tabs = await browser.tabs.query(windowId == null ? { currentWindow: true } : { windowId });
  const candidates = tabs.filter((t) => !(settings.skipPinnedTabs && t.pinned) && isGroupableUrl(t.url));
  const buckets = FTG.bucketByDomain(candidates);
  const minTabs = Math.max(1, Number(settings.domainGroupMinTabs) || 1);
  let groups = 0;
  const colors = FTG.COLORS.filter((c) => c !== "grey");
  let colorIndex = 0;
  for (const [label, bucketTabs] of buckets) {
    if (bucketTabs.length < minTabs) continue;
    const wid = bucketTabs[0].windowId;
    const [existing] = await browser.tabGroups.query({ windowId: wid, title: label });
    const color = existing ? existing.color : colors[colorIndex++ % colors.length];
    await addTabsToTitledGroup(bucketTabs, wid, label, color);
    groups += 1;
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Open group operations
// ---------------------------------------------------------------------------

async function newTabInGroup(groupId) {
  const tabs = await groupTabs(groupId);
  if (!tabs.length) return null;
  const last = tabs.reduce((a, b) => (a.index > b.index ? a : b));
  const tab = await browser.tabs.create({ windowId: last.windowId, index: last.index + 1, active: true });
  await browser.tabs.group({ tabIds: [tab.id], groupId });
  return tab;
}

async function closeGroup(groupId) {
  const tabs = await groupTabs(groupId);
  if (tabs.length) await browser.tabs.remove(tabs.map((t) => t.id));
}

async function ungroupGroup(groupId) {
  const tabs = await groupTabs(groupId);
  if (tabs.length) await browser.tabs.ungroup(tabs.map((t) => t.id));
}

async function moveGroupToWindow(groupId, windowId) {
  await browser.tabGroups.move(groupId, { windowId, index: -1 });
}

async function moveGroupToNewWindow(groupId) {
  const tabs = await groupTabs(groupId);
  if (!tabs.length) return null;
  const win = await browser.windows.create({ url: "about:blank" });
  const placeholder = win.tabs && win.tabs[0];
  await browser.tabGroups.move(groupId, { windowId: win.id, index: -1 });
  if (placeholder) await browser.tabs.remove(placeholder.id).catch(() => {});
  return win.id;
}

async function setGroupCollapsed(groupId, collapsed) {
  if (collapsed) {
    // Firefox refuses to collapse the group containing the active tab, so
    // activate the nearest tab outside the group first.
    const tabs = await groupTabs(groupId);
    const active = tabs.find((t) => t.active);
    if (active) {
      const all = await browser.tabs.query({ windowId: active.windowId });
      const outside = all.filter((t) => t.groupId !== groupId);
      if (!outside.length) return false;
      const after = outside.find((t) => t.index > active.index);
      const target = after || outside[outside.length - 1];
      await browser.tabs.update(target.id, { active: true });
    }
  }
  await browser.tabGroups.update(groupId, { collapsed });
  return true;
}

async function setAllCollapsed(windowId, collapsed) {
  const groups = await browser.tabGroups.query(windowId == null ? {} : { windowId });
  const active = await getActiveTab(windowId);
  for (const group of groups) {
    if (windowId == null && active && group.windowId !== active.windowId) continue;
    if (collapsed && active && active.groupId === group.id) continue;
    await browser.tabGroups.update(group.id, { collapsed }).catch(() => {});
  }
}

async function mergeOpenGroupsWithSameTitle(windowId) {
  const groups = await browser.tabGroups.query(windowId == null ? {} : { windowId });
  const byKey = new Map();
  let merged = 0;
  for (const group of groups) {
    const key = `${group.windowId}\u0000${(group.title || "").trim().toLowerCase()}`;
    if (!group.title || !group.title.trim()) continue;
    if (byKey.has(key)) {
      const target = byKey.get(key);
      const tabs = await groupTabs(group.id);
      if (tabs.length) await browser.tabs.group({ tabIds: tabs.map((t) => t.id), groupId: target });
      merged += 1;
    } else {
      byKey.set(key, group.id);
    }
  }
  return merged;
}

async function activateAdjacentGroup(direction) {
  const active = await getActiveTab();
  if (!active) return;
  const groups = await browser.tabGroups.query({ windowId: active.windowId });
  if (!groups.length) return;
  const tabs = await browser.tabs.query({ windowId: active.windowId });
  const firstIndex = new Map();
  for (const tab of tabs) {
    if (isGrouped(tab) && !firstIndex.has(tab.groupId)) firstIndex.set(tab.groupId, tab.index);
  }
  const ordered = groups
    .filter((g) => firstIndex.has(g.id))
    .sort((a, b) => firstIndex.get(a.id) - firstIndex.get(b.id));
  if (!ordered.length) return;
  let pos = ordered.findIndex((g) => g.id === active.groupId);
  if (pos === -1) {
    // Not in a group: pick the first group after/before the active tab.
    pos = direction > 0
      ? ordered.findIndex((g) => firstIndex.get(g.id) > active.index)
      : ordered.map((g) => firstIndex.get(g.id) < active.index).lastIndexOf(true);
    if (pos === -1) pos = direction > 0 ? 0 : ordered.length - 1;
  } else {
    pos = (pos + direction + ordered.length) % ordered.length;
  }
  const target = ordered[pos];
  if (target.collapsed) await browser.tabGroups.update(target.id, { collapsed: false });
  const first = tabs.find((t) => t.groupId === target.id);
  if (first) await browser.tabs.update(first.id, { active: true });
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

function tabToSnapshot(tab) {
  return { url: tab.url, title: tab.title || tab.url, pinned: Boolean(tab.pinned) };
}

async function orderedGroupsInWindow(windowId) {
  const [groups, tabs] = await Promise.all([
    browser.tabGroups.query({ windowId }),
    browser.tabs.query({ windowId }),
  ]);
  const firstIndex = new Map();
  for (const tab of tabs) {
    if (isGrouped(tab) && !firstIndex.has(tab.groupId)) firstIndex.set(tab.groupId, tab.index);
  }
  groups.sort((a, b) => (firstIndex.get(a.id) ?? 1e9) - (firstIndex.get(b.id) ?? 1e9));
  return { groups, tabs };
}

async function captureWindow(windowId, name) {
  const { groups, tabs } = await orderedGroupsInWindow(windowId);
  const snapshot = {
    id: FTG.newId("snap"),
    name: name || `Window snapshot ${new Date().toLocaleString()}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    groups: groups.map((g) => ({
      title: g.title || "",
      color: g.color,
      collapsed: Boolean(g.collapsed),
      tabs: tabs.filter((t) => t.groupId === g.id).map(tabToSnapshot),
    })),
    ungrouped: tabs.filter((t) => !isGrouped(t)).map(tabToSnapshot),
  };
  return snapshot;
}

async function captureGroup(groupId, name) {
  const group = await browser.tabGroups.get(groupId);
  const tabs = await groupTabs(groupId);
  return {
    id: FTG.newId("snap"),
    name: name || group.title || "Untitled group",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    groups: [
      {
        title: group.title || "",
        color: group.color,
        collapsed: Boolean(group.collapsed),
        tabs: tabs.map(tabToSnapshot),
      },
    ],
    ungrouped: [],
  };
}

async function saveSnapshot(snapshot) {
  const { snapshots } = await loadState();
  snapshots.unshift(snapshot);
  await saveSnapshots(snapshots);
  return snapshot;
}

async function createTabsFromList(list, windowId, { discarded }) {
  const created = [];
  let skipped = 0;
  for (const entry of list) {
    if (!FTG.isRestorableUrl(entry.url)) {
      skipped += 1;
      continue;
    }
    const props = { windowId, url: entry.url, active: false, pinned: Boolean(entry.pinned) };
    if (discarded && !entry.pinned && entry.url !== "about:blank") {
      props.discarded = true;
      props.title = entry.title || entry.url;
    }
    try {
      created.push(await browser.tabs.create(props));
    } catch (e) {
      // Some URLs are rejected at runtime (e.g. privileged schemes). Fall back
      // to a non-discarded tab before giving up on the entry.
      try {
        created.push(await browser.tabs.create({ windowId, url: entry.url, active: false }));
      } catch (e2) {
        skipped += 1;
      }
    }
  }
  return { created, skipped };
}

/**
 * Restore a whole snapshot or a single group out of it.
 * options: { groupIndex?: number, inNewWindow?: boolean, windowId?: number }
 */
async function restoreSnapshot(snapshotId, options = {}) {
  const { snapshots, settings } = await loadState();
  const snapshot = snapshots.find((s) => s.id === snapshotId);
  if (!snapshot) throw new Error("Snapshot not found");

  let windowId = options.windowId;
  let placeholder = null;
  const inNewWindow = options.inNewWindow ?? settings.restoreInNewWindow;
  if (inNewWindow) {
    const win = await browser.windows.create({ url: "about:blank" });
    windowId = win.id;
    placeholder = win.tabs && win.tabs[0];
  } else if (windowId == null) {
    const win = await browser.windows.getLastFocused({ windowTypes: ["normal"] });
    windowId = win.id;
  }

  const groups = typeof options.groupIndex === "number" ? [snapshot.groups[options.groupIndex]].filter(Boolean) : snapshot.groups;
  const ungrouped = typeof options.groupIndex === "number" ? [] : snapshot.ungrouped || [];
  const discarded = settings.restoreDiscarded;

  let restored = 0;
  let skipped = 0;
  for (const group of groups) {
    const { created, skipped: s } = await createTabsFromList(group.tabs, windowId, { discarded });
    skipped += s;
    restored += created.length;
    const groupable = created.filter((t) => !t.pinned);
    if (groupable.length) {
      const props = { title: group.title || "" };
      if (FTG.isColor(group.color)) props.color = group.color;
      const groupId = await createGroup(groupable.map((t) => t.id), windowId, props);
      if (group.collapsed) await browser.tabGroups.update(groupId, { collapsed: true }).catch(() => {});
    }
  }
  if (ungrouped.length) {
    const { created, skipped: s } = await createTabsFromList(ungrouped, windowId, { discarded });
    skipped += s;
    restored += created.length;
  }
  if (placeholder && restored > 0) await browser.tabs.remove(placeholder.id).catch(() => {});
  return { restored, skipped, windowId };
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

async function commandGroupTabs() {
  const selected = await getSelectedTabs();
  const active = selected.find((t) => t.active) || (await getActiveTab());
  if (!active) return;
  const { settings } = await loadState();
  const tabs = selected.filter((t) => !t.pinned);
  if (!tabs.length) return;
  if (isGrouped(active)) {
    const others = tabs.filter((t) => t.groupId !== active.groupId).map((t) => t.id);
    if (others.length) await browser.tabs.group({ tabIds: others, groupId: active.groupId });
    return;
  }
  const title = FTG.domainLabel(active.url) || "";
  await createGroup(tabs.map((t) => t.id), active.windowId, { title, color: settings.defaultColor });
}

async function commandUngroupTabs() {
  const selected = await getSelectedTabs();
  const ids = selected.filter(isGrouped).map((t) => t.id);
  if (ids.length) await browser.tabs.ungroup(ids);
}

async function commandToggleCollapse() {
  const active = await getActiveTab();
  if (!active || !isGrouped(active)) return;
  const group = await browser.tabGroups.get(active.groupId);
  await setGroupCollapsed(group.id, !group.collapsed);
}

async function withActiveGroup(fn) {
  const active = await getActiveTab();
  if (!active || !isGrouped(active)) return;
  await fn(active.groupId, active);
}

const COMMANDS = {
  "group-tabs": commandGroupTabs,
  "ungroup-tabs": commandUngroupTabs,
  "toggle-collapse-group": commandToggleCollapse,
  "auto-group-by-domain": () => autoGroupByDomain(),
  "apply-rules": () => applyRulesToWindow(),
  "new-tab-in-group": () => withActiveGroup((gid) => newTabInGroup(gid)),
  "close-group": () => withActiveGroup((gid) => closeGroup(gid)),
  "move-group-to-new-window": () => withActiveGroup((gid) => moveGroupToNewWindow(gid)),
  "collapse-all-groups": () => setAllCollapsed(undefined, true),
  "expand-all-groups": () => setAllCollapsed(undefined, false),
  "toggle-pin-tab": async () => {
    const active = await getActiveTab();
    if (active) await browser.tabs.update(active.id, { pinned: !active.pinned });
  },
  "duplicate-tab": async () => {
    const active = await getActiveTab();
    if (!active) return;
    const dup = await browser.tabs.duplicate(active.id);
    if (isGrouped(active) && dup && dup.groupId !== active.groupId) {
      await browser.tabs.group({ tabIds: [dup.id], groupId: active.groupId }).catch(() => {});
    }
  },
  "save-window-snapshot": async () => {
    const active = await getActiveTab();
    if (active) await saveSnapshot(await captureWindow(active.windowId));
  },
  "activate-next-group": () => activateAdjacentGroup(1),
  "activate-previous-group": () => activateAdjacentGroup(-1),
};

browser.commands.onCommand.addListener((command) => {
  const handler = COMMANDS[command];
  if (handler) handler().catch((e) => console.warn(`command ${command} failed`, e));
});

// ---------------------------------------------------------------------------
// Tab events → auto grouping
// ---------------------------------------------------------------------------

browser.tabs.onUpdated.addListener(
  (tabId, changeInfo, tab) => {
    if (!("url" in changeInfo) && !("title" in changeInfo)) return;
    loadState()
      .then((state) => (state.settings.autoGroupEnabled ? applyRulesToTab(tab, state) : false))
      .catch((e) => console.warn("auto-group failed", e));
  },
  { properties: ["url", "title"] }
);

browser.runtime.onStartup.addListener(async () => {
  const { settings } = await loadState();
  if (!settings.applyRulesOnStartup) return;
  // Give session restore a moment to recreate the windows before grouping.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const windows = await browser.windows.getAll({ windowTypes: ["normal"] });
  for (const win of windows) await applyRulesToWindow(win.id).catch(() => {});
});

// ---------------------------------------------------------------------------
// Tab context menu
// ---------------------------------------------------------------------------

const MENU_ROOT = "ftg-root";
const MENU_NEW_GROUP = "ftg-new-group";
const MENU_UNGROUP = "ftg-ungroup";
const MENU_SAVE_GROUP = "ftg-save-group";
const MENU_SAVE_WINDOW = "ftg-save-window";
const MENU_BY_DOMAIN = "ftg-by-domain";
const MENU_APPLY_RULES = "ftg-apply-rules";
const MENU_GROUP_PREFIX = "ftg-group-";
let dynamicMenuIds = [];

async function buildStaticMenus() {
  await browser.menus.removeAll();
  browser.menus.create({ id: MENU_ROOT, title: "Fox Tab Groups", contexts: ["tab"] });
  browser.menus.create({ id: MENU_NEW_GROUP, parentId: MENU_ROOT, title: "Add to new group", contexts: ["tab"] });
  browser.menus.create({ id: MENU_UNGROUP, parentId: MENU_ROOT, title: "Remove from group", contexts: ["tab"] });
  browser.menus.create({ id: "ftg-sep-1", parentId: MENU_ROOT, type: "separator", contexts: ["tab"] });
  browser.menus.create({ id: MENU_SAVE_GROUP, parentId: MENU_ROOT, title: "Save this group as snapshot", contexts: ["tab"] });
  browser.menus.create({ id: MENU_SAVE_WINDOW, parentId: MENU_ROOT, title: "Save window as snapshot", contexts: ["tab"] });
  browser.menus.create({ id: "ftg-sep-2", parentId: MENU_ROOT, type: "separator", contexts: ["tab"] });
  browser.menus.create({ id: MENU_BY_DOMAIN, parentId: MENU_ROOT, title: "Auto-group window by domain", contexts: ["tab"] });
  browser.menus.create({ id: MENU_APPLY_RULES, parentId: MENU_ROOT, title: "Apply grouping rules to window", contexts: ["tab"] });
}

browser.menus.onShown.addListener(async (info, tab) => {
  if (!tab || !info.contexts.includes("tab")) return;
  for (const id of dynamicMenuIds) await browser.menus.remove(id).catch(() => {});
  dynamicMenuIds = [];
  const selected = await getSelectedTabs(tab.windowId);
  const targets = selected.some((t) => t.id === tab.id) ? selected : [tab];
  const groups = await browser.tabGroups.query({ windowId: tab.windowId });
  const others = groups.filter((g) => !targets.every((t) => t.groupId === g.id));
  for (const g of others) {
    const id = `${MENU_GROUP_PREFIX}${g.id}`;
    browser.menus.create({
      id,
      parentId: MENU_ROOT,
      title: `Add to “${g.title || "Untitled group"}”`,
      contexts: ["tab"],
    });
    dynamicMenuIds.push(id);
  }
  const anyGrouped = targets.some(isGrouped);
  await browser.menus.update(MENU_UNGROUP, { enabled: anyGrouped });
  await browser.menus.update(MENU_SAVE_GROUP, { enabled: isGrouped(tab) });
  await browser.menus.refresh();
});

browser.menus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;
  const selected = await getSelectedTabs(tab.windowId);
  const targets = selected.some((t) => t.id === tab.id) ? selected : [tab];
  const groupable = targets.filter((t) => !t.pinned).map((t) => t.id);
  const { settings } = await loadState();
  try {
    if (info.menuItemId === MENU_NEW_GROUP) {
      if (groupable.length) {
        await createGroup(groupable, tab.windowId, { title: FTG.domainLabel(tab.url) || "", color: settings.defaultColor });
      }
    } else if (info.menuItemId === MENU_UNGROUP) {
      const ids = targets.filter(isGrouped).map((t) => t.id);
      if (ids.length) await browser.tabs.ungroup(ids);
    } else if (info.menuItemId === MENU_SAVE_GROUP) {
      if (isGrouped(tab)) await saveSnapshot(await captureGroup(tab.groupId));
    } else if (info.menuItemId === MENU_SAVE_WINDOW) {
      await saveSnapshot(await captureWindow(tab.windowId));
    } else if (info.menuItemId === MENU_BY_DOMAIN) {
      await autoGroupByDomain(tab.windowId);
    } else if (info.menuItemId === MENU_APPLY_RULES) {
      await applyRulesToWindow(tab.windowId);
    } else if (String(info.menuItemId).startsWith(MENU_GROUP_PREFIX)) {
      const groupId = Number(String(info.menuItemId).slice(MENU_GROUP_PREFIX.length));
      if (groupable.length) await browser.tabs.group({ tabIds: groupable, groupId });
    }
  } catch (e) {
    console.warn("menu action failed", e);
  }
});

browser.runtime.onInstalled.addListener(() => {
  buildStaticMenus().catch((e) => console.warn("menu setup failed", e));
});
browser.runtime.onStartup.addListener(() => {
  buildStaticMenus().catch((e) => console.warn("menu setup failed", e));
});

// ---------------------------------------------------------------------------
// Messages from popup / options
// ---------------------------------------------------------------------------

const MESSAGE_HANDLERS = {
  applyRules: ({ windowId }) => applyRulesToWindow(windowId),
  autoGroupByDomain: ({ windowId }) => autoGroupByDomain(windowId),
  newTabInGroup: ({ groupId }) => newTabInGroup(groupId),
  closeGroup: ({ groupId }) => closeGroup(groupId),
  ungroupGroup: ({ groupId }) => ungroupGroup(groupId),
  moveGroupToWindow: ({ groupId, windowId }) => moveGroupToWindow(groupId, windowId),
  moveGroupToNewWindow: ({ groupId }) => moveGroupToNewWindow(groupId),
  setGroupCollapsed: ({ groupId, collapsed }) => setGroupCollapsed(groupId, collapsed),
  setAllCollapsed: ({ windowId, collapsed }) => setAllCollapsed(windowId, collapsed),
  mergeOpenGroups: ({ windowId }) => mergeOpenGroupsWithSameTitle(windowId),
  captureWindow: ({ windowId, name }) => captureWindow(windowId, name),
  saveWindowSnapshot: async ({ windowId, name }) => saveSnapshot(await captureWindow(windowId, name)),
  saveGroupSnapshot: async ({ groupId, name }) => saveSnapshot(await captureGroup(groupId, name)),
  restoreSnapshot: ({ snapshotId, options }) => restoreSnapshot(snapshotId, options || {}),
};

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.type !== "string") return undefined;
  const handler = MESSAGE_HANDLERS[message.type];
  if (!handler) return undefined;
  return handler(message)
    .then((result) => ({ ok: true, result }))
    .catch((e) => ({ ok: false, error: e && e.message ? e.message : String(e) }));
});
