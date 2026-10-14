"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const FTG = require("../shared/rules.js");

test("domainLabel strips www and handles junk", () => {
  assert.equal(FTG.domainLabel("https://www.github.com/x/y"), "github.com");
  assert.equal(FTG.domainLabel("https://mail.google.com/"), "mail.google.com");
  assert.equal(FTG.domainLabel("about:blank"), "");
  assert.equal(FTG.domainLabel("not a url"), "");
});

test("domain rules match host and sub-domains, wildcard matches sub-domains only", () => {
  const rule = { matchType: "domain", pattern: "example.com, *.mozilla.org", enabled: true };
  assert.ok(FTG.ruleMatches(rule, { url: "https://example.com/" }));
  assert.ok(FTG.ruleMatches(rule, { url: "https://www.example.com/path" }));
  assert.ok(!FTG.ruleMatches(rule, { url: "https://notexample.com/" }));
  assert.ok(FTG.ruleMatches(rule, { url: "https://addons.mozilla.org/" }));
  assert.ok(!FTG.ruleMatches(rule, { url: "https://mozilla.org/" }));
  assert.ok(!FTG.ruleMatches(rule, { url: "about:blank" }));
});

test("contains rules are case-insensitive unless asked", () => {
  const rule = { matchType: "title-contains", pattern: "Jira", enabled: true };
  assert.ok(FTG.ruleMatches(rule, { url: "", title: "my jira board" }));
  assert.ok(!FTG.ruleMatches({ ...rule, caseSensitive: true }, { url: "", title: "my jira board" }));
  const urlRule = { matchType: "url-contains", pattern: "/pull/,/issues/", enabled: true };
  assert.ok(FTG.ruleMatches(urlRule, { url: "https://github.com/a/b/issues/3" }));
  assert.ok(!FTG.ruleMatches(urlRule, { url: "https://github.com/a/b" }));
});

test("regex rules match and invalid regexes never match", () => {
  assert.ok(FTG.ruleMatches({ matchType: "url-regex", pattern: "^https://docs\\.google\\.com/(document|spreadsheets)" }, { url: "https://docs.google.com/document/d/1" }));
  assert.ok(!FTG.ruleMatches({ matchType: "url-regex", pattern: "(" }, { url: "https://x.com/(" }));
  assert.equal(FTG.validateRegex("(") !== null, true);
  assert.equal(FTG.validateRegex("a+"), null);
});

test("findMatchingRule respects order and enabled flag", () => {
  const rules = [
    { id: "a", matchType: "domain", pattern: "github.com", enabled: false, groupTitle: "Disabled" },
    { id: "b", matchType: "domain", pattern: "github.com", enabled: true, groupTitle: "Code" },
    { id: "c", matchType: "url-contains", pattern: "github", enabled: true, groupTitle: "Later" },
  ];
  const match = FTG.findMatchingRule(rules, { url: "https://github.com/" });
  assert.equal(match.id, "b");
  assert.equal(FTG.findMatchingRule(rules, { url: "https://example.com/" }), null);
});

test("groupTitleForRule falls back sensibly", () => {
  const tab = { url: "https://www.reddit.com/r/firefox" };
  assert.equal(FTG.groupTitleForRule({ groupTitle: " Social ", name: "x", pattern: "reddit.com", matchType: "domain" }, tab), "Social");
  assert.equal(FTG.groupTitleForRule({ groupTitle: "", name: "Reddit", pattern: "reddit.com", matchType: "domain" }, tab), "Reddit");
  assert.equal(FTG.groupTitleForRule({ groupTitle: "", name: "", pattern: "reddit.com", matchType: "domain" }, tab), "reddit.com");
  assert.equal(FTG.groupTitleForRule({ groupTitle: "", name: "", pattern: "foo, bar", matchType: "url-contains" }, tab), "foo");
});

test("normalizeRule rejects junk and fills defaults", () => {
  assert.equal(FTG.normalizeRule(null), null);
  assert.equal(FTG.normalizeRule({ pattern: "   " }), null);
  const rule = FTG.normalizeRule({ pattern: "example.com", color: "magenta", matchType: "bogus" });
  assert.equal(rule.matchType, "domain");
  assert.equal(rule.color, "grey");
  assert.equal(rule.enabled, true);
  assert.match(rule.id, /^rule_/);
});

test("normalizeSnapshot and mergeSameNameGroups", () => {
  const snap = FTG.normalizeSnapshot({
    name: "Work",
    groups: [
      { title: "Docs", color: "blue", tabs: [{ url: "https://a.com", title: "A" }] },
      { title: "docs ", color: "red", tabs: [{ url: "https://b.com" }, { url: 42 }] },
      { title: "", tabs: [{ url: "https://c.com" }] },
      { title: "", tabs: [{ url: "https://d.com" }] },
    ],
    ungrouped: [{ url: "https://e.com" }, {}],
  });
  assert.equal(snap.groups.length, 4);
  assert.equal(snap.groups[1].tabs.length, 1, "invalid tab dropped");
  assert.equal(snap.groups[1].tabs[0].title, "https://b.com", "title defaults to url");
  assert.equal(snap.ungrouped.length, 1);
  assert.equal(FTG.countSnapshotTabs(snap), 5);

  const merged = FTG.mergeSameNameGroups(snap);
  assert.equal(merged.groups.length, 3, "same-name groups merged, untitled groups left alone");
  assert.equal(merged.groups[0].tabs.length, 2);
  assert.equal(merged.groups[0].color, "blue", "first group's colour wins");
  assert.equal(snap.groups[0].tabs.length, 1, "input not mutated");
});

test("isRestorableUrl only allows URLs extensions may open", () => {
  assert.ok(FTG.isRestorableUrl("https://example.com"));
  assert.ok(FTG.isRestorableUrl("http://example.com"));
  assert.ok(FTG.isRestorableUrl("about:blank"));
  assert.ok(!FTG.isRestorableUrl("about:config"));
  assert.ok(!FTG.isRestorableUrl("file:///etc/passwd"));
  assert.ok(!FTG.isRestorableUrl("moz-extension://abc/popup.html"));
  assert.ok(!FTG.isRestorableUrl("javascript:alert(1)"));
});

test("bucketByDomain groups by label and skips host-less URLs", () => {
  const buckets = FTG.bucketByDomain([
    { id: 1, url: "https://www.github.com/a" },
    { id: 2, url: "https://github.com/b" },
    { id: 3, url: "about:blank" },
    { id: 4, url: "https://news.ycombinator.com/" },
  ]);
  assert.deepEqual([...buckets.keys()], ["github.com", "news.ycombinator.com"]);
  assert.deepEqual(buckets.get("github.com").map((t) => t.id), [1, 2]);
});

test("parseImportPayload accepts objects, bare arrays and rejects garbage", () => {
  assert.ok(FTG.parseImportPayload("not json").error);
  assert.ok(FTG.parseImportPayload("{}").error);
  const rules = FTG.parseImportPayload(JSON.stringify([{ pattern: "a.com" }]));
  assert.equal(rules.rules.length, 1);
  assert.equal(rules.snapshots.length, 0);
  const both = FTG.parseImportPayload(
    JSON.stringify({ rules: [{ pattern: "a.com" }], snapshots: [{ groups: [{ tabs: [{ url: "https://x" }] }] }], settings: { autoGroupEnabled: false } })
  );
  assert.equal(both.rules.length, 1);
  assert.equal(both.snapshots.length, 1);
  assert.equal(both.settings.autoGroupEnabled, false);
});
