/*
 * Shared, side-effect-free logic used by the background script, the popup,
 * the options page and the test-suite. It is written as a tiny UMD so that the
 * same file can be loaded with a <script> tag in extension pages and with
 * require() under Node for tests.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.FTG = Object.assign(root.FTG || {}, factory());
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

  const COLOR_HEX = {
    grey: "#8f8f9d",
    blue: "#0062fa",
    red: "#e22850",
    yellow: "#ffbd4f",
    green: "#2ac3a2",
    pink: "#ff6bba",
    purple: "#9059ff",
    cyan: "#00ddff",
    orange: "#ff7139",
  };

  const MATCH_TYPES = {
    domain: "Domain",
    "url-contains": "URL contains",
    "url-regex": "URL matches regex",
    "title-contains": "Title contains",
    "title-regex": "Title matches regex",
  };

  const DEFAULT_SETTINGS = {
    autoGroupEnabled: true,
    skipPinnedTabs: true,
    applyRulesOnStartup: false,
    ungroupWhenNoRuleMatches: false,
    defaultColor: "grey",
    domainGroupMinTabs: 2,
    restoreInNewWindow: false,
    restoreDiscarded: true,
    showAllWindows: false,
  };

  const NO_GROUP = -1;

  function newId(prefix) {
    const rand = Math.random().toString(36).slice(2, 10);
    return `${prefix || "id"}_${Date.now().toString(36)}_${rand}`;
  }

  function hostnameOf(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch (e) {
      return "";
    }
  }

  function stripWww(host) {
    return host.replace(/^www\./, "");
  }

  /**
   * Label used when grouping "by domain": strips a leading www. and keeps the
   * rest of the host. Returns "" for URLs without a host (about:, file:, ...).
   */
  function domainLabel(url) {
    return stripWww(hostnameOf(url));
  }

  function splitPatterns(pattern) {
    return String(pattern || "")
      .split(/[\n,]/)
      .map((p) => p.trim())
      .filter(Boolean);
  }

  function domainMatches(host, pattern) {
    const p = pattern.trim().toLowerCase();
    if (!p || !host) return false;
    if (p.startsWith("*.")) {
      // "*.example.com" matches sub-domains only; a bare "example.com"
      // pattern already covers the apex plus its sub-domains.
      return host.endsWith("." + p.slice(2));
    }
    return host === p || host.endsWith("." + p);
  }

  const regexCache = new Map();
  function compileRegex(pattern, caseSensitive) {
    const flags = caseSensitive ? "" : "i";
    const key = flags + "/" + pattern;
    if (regexCache.has(key)) return regexCache.get(key);
    let re = null;
    try {
      re = new RegExp(pattern, flags);
    } catch (e) {
      re = null;
    }
    regexCache.set(key, re);
    return re;
  }

  function containsMatches(haystack, pattern, caseSensitive) {
    if (!pattern) return false;
    if (caseSensitive) return haystack.includes(pattern);
    return haystack.toLowerCase().includes(pattern.toLowerCase());
  }

  /** Returns true when the rule matches the given tab-like object ({url, title}). */
  function ruleMatches(rule, tab) {
    if (!rule || !tab) return false;
    const url = tab.url || "";
    const title = tab.title || "";
    const cs = Boolean(rule.caseSensitive);
    switch (rule.matchType) {
      case "domain": {
        const host = hostnameOf(url);
        return splitPatterns(rule.pattern).some((p) => domainMatches(host, p));
      }
      case "url-contains":
        return splitPatterns(rule.pattern).some((p) => containsMatches(url, p, cs));
      case "title-contains":
        return splitPatterns(rule.pattern).some((p) => containsMatches(title, p, cs));
      case "url-regex": {
        const re = compileRegex(rule.pattern, cs);
        return Boolean(re && re.test(url));
      }
      case "title-regex": {
        const re = compileRegex(rule.pattern, cs);
        return Boolean(re && re.test(title));
      }
      default:
        return false;
    }
  }

  /** First enabled rule (in list order) matching the tab, or null. */
  function findMatchingRule(rules, tab) {
    for (const rule of rules || []) {
      if (rule && rule.enabled !== false && ruleMatches(rule, tab)) return rule;
    }
    return null;
  }

  /** Title the matched tab should be grouped under. */
  function groupTitleForRule(rule, tab) {
    if (rule.groupTitle && rule.groupTitle.trim()) return rule.groupTitle.trim();
    if (rule.name && rule.name.trim()) return rule.name.trim();
    if (rule.matchType === "domain") {
      const label = domainLabel(tab && tab.url);
      if (label) return label;
    }
    return splitPatterns(rule.pattern)[0] || "Group";
  }

  function validateRegex(pattern) {
    try {
      new RegExp(pattern);
      return null;
    } catch (e) {
      return e.message;
    }
  }

  function isColor(c) {
    return COLORS.includes(c);
  }

  /** Coerce arbitrary (imported) data into a well-formed rule or return null. */
  function normalizeRule(raw) {
    if (!raw || typeof raw !== "object") return null;
    const matchType = MATCH_TYPES[raw.matchType] ? raw.matchType : "domain";
    const pattern = typeof raw.pattern === "string" ? raw.pattern.trim() : "";
    if (!pattern) return null;
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : newId("rule"),
      name: typeof raw.name === "string" ? raw.name.trim() : "",
      enabled: raw.enabled !== false,
      matchType,
      pattern,
      groupTitle: typeof raw.groupTitle === "string" ? raw.groupTitle.trim() : "",
      color: isColor(raw.color) ? raw.color : "grey",
      caseSensitive: Boolean(raw.caseSensitive),
    };
  }

  function normalizeSnapshotTab(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.url !== "string" || !raw.url) return null;
    return {
      url: raw.url,
      title: typeof raw.title === "string" ? raw.title : raw.url,
      pinned: Boolean(raw.pinned),
    };
  }

  function normalizeSnapshotGroup(raw) {
    if (!raw || typeof raw !== "object") return null;
    const tabs = Array.isArray(raw.tabs) ? raw.tabs.map(normalizeSnapshotTab).filter(Boolean) : [];
    return {
      title: typeof raw.title === "string" ? raw.title : "",
      color: isColor(raw.color) ? raw.color : "grey",
      collapsed: Boolean(raw.collapsed),
      tabs,
    };
  }

  /** Coerce arbitrary (imported) data into a well-formed snapshot or return null. */
  function normalizeSnapshot(raw) {
    if (!raw || typeof raw !== "object") return null;
    const groups = Array.isArray(raw.groups) ? raw.groups.map(normalizeSnapshotGroup).filter(Boolean) : [];
    const ungrouped = Array.isArray(raw.ungrouped) ? raw.ungrouped.map(normalizeSnapshotTab).filter(Boolean) : [];
    if (!groups.length && !ungrouped.length) return null;
    const now = Date.now();
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : newId("snap"),
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "Snapshot",
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
      groups,
      ungrouped,
    };
  }

  /** Merge groups that share the same (trimmed, case-insensitive) title inside a snapshot. */
  function mergeSameNameGroups(snapshot) {
    const byKey = new Map();
    const merged = [];
    for (const group of snapshot.groups) {
      const key = (group.title || "").trim().toLowerCase();
      if (key && byKey.has(key)) {
        const target = byKey.get(key);
        target.tabs = target.tabs.concat(group.tabs);
      } else {
        const copy = { ...group, tabs: group.tabs.slice() };
        merged.push(copy);
        if (key) byKey.set(key, copy);
      }
    }
    return { ...snapshot, groups: merged, updatedAt: Date.now() };
  }

  function countSnapshotTabs(snapshot) {
    const inGroups = snapshot.groups.reduce((n, g) => n + g.tabs.length, 0);
    return inGroups + (snapshot.ungrouped ? snapshot.ungrouped.length : 0);
  }

  /** URLs a WebExtension is allowed to open with tabs.create(). */
  function isRestorableUrl(url) {
    return /^(https?|ftp):\/\//i.test(url) || url === "about:blank";
  }

  /**
   * Given a list of tab-like objects, bucket them by domain label.
   * Returns Map<label, tabs[]> preserving first-seen order.
   */
  function bucketByDomain(tabs) {
    const buckets = new Map();
    for (const tab of tabs) {
      const label = domainLabel(tab.url);
      if (!label) continue;
      if (!buckets.has(label)) buckets.set(label, []);
      buckets.get(label).push(tab);
    }
    return buckets;
  }

  /** Normalize an export payload ({rules} and/or {snapshots}) into arrays. */
  function parseImportPayload(json) {
    let data;
    try {
      data = typeof json === "string" ? JSON.parse(json) : json;
    } catch (e) {
      return { error: "File is not valid JSON." };
    }
    if (Array.isArray(data)) {
      // Bare array: guess from the shape of the first element.
      const first = data[0] || {};
      if ("pattern" in first) data = { rules: data };
      else data = { snapshots: data };
    }
    if (!data || typeof data !== "object") return { error: "Unrecognised file contents." };
    const rules = Array.isArray(data.rules) ? data.rules.map(normalizeRule).filter(Boolean) : [];
    const snapshots = Array.isArray(data.snapshots) ? data.snapshots.map(normalizeSnapshot).filter(Boolean) : [];
    const settings = data.settings && typeof data.settings === "object" ? data.settings : null;
    if (!rules.length && !snapshots.length && !settings) {
      return { error: "No rules or snapshots were found in that file." };
    }
    return { rules, snapshots, settings };
  }

  return {
    COLORS,
    COLOR_HEX,
    MATCH_TYPES,
    DEFAULT_SETTINGS,
    NO_GROUP,
    newId,
    hostnameOf,
    domainLabel,
    splitPatterns,
    domainMatches,
    ruleMatches,
    findMatchingRule,
    groupTitleForRule,
    validateRegex,
    isColor,
    normalizeRule,
    normalizeSnapshot,
    mergeSameNameGroups,
    countSnapshotTabs,
    isRestorableUrl,
    bucketByDomain,
    parseImportPayload,
  };
});
