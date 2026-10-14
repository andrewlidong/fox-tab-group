# Fox Tab Groups

A Firefox extension that brings the feature set of Chrome's *Tab Groups Extension* to Firefox's native tab groups:

- **Automatic grouping** – tabs are sorted into named, coloured groups as they load, using your own matching rules (domain, URL / title contains, URL / title regex). Rules can be added, edited, re-ordered, enabled/disabled, imported and exported.
- **Snapshots** – save the tabs and groups of a window (or a single group) and restore them later, in the current window or a new one. Snapshots can be renamed, edited tab-by-tab, merged (groups with the same name), updated, imported and exported as JSON.
- **Manage open groups** – from the toolbar popup: activate or close tabs and groups, collapse / expand, rename, recolour, open a new tab inside a group, move a group to another (or a new) window, move individual tabs between groups, merge same-name groups, and auto-group a whole window by domain.
- **Keyboard shortcuts** – group / ungroup, collapse / expand, auto-group by domain, apply rules, new tab in group, close group, move group to new window, pin, duplicate, save snapshot, jump to next / previous group. Every shortcut can be changed from the settings page.
- **Tab context menu** – right-click a tab (or a multi-selection) to add it to a new or existing group, remove it from its group, or save the group / window as a snapshot.

Everything is stored locally in your Firefox profile (`storage.local`). No data leaves the browser.

## Requirements

Firefox **139 or newer** (the first release with the `tabGroups` WebExtension API). Tab groups themselves must be enabled in Firefox (they are on by default since 138).

## Install

### Temporary (for development)

1. Clone this repository.
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Click **Load Temporary Add-on…** and pick `manifest.json` from the clone.

The add-on stays installed until you restart Firefox.

### Permanent

Build a package and sign it through [addons.mozilla.org](https://addons.mozilla.org/developers/) (unlisted self-distribution is fine), or run Firefox Developer Edition / Nightly with `xpinstall.signatures.required` set to `false` and install the built `.zip`/`.xpi` from `about:addons`.

```sh
npm run build        # writes dist/fox_tab_groups-<version>.zip via web-ext
```

## Using it

Click the toolbar icon (default shortcut **Alt+Shift+F**) to open the popup. It has three views; the ⤢ button opens the same UI in a full tab.

### Groups

Shows the groups and ungrouped tabs of the current window (tick *Show all windows* under ⋯ to see every window).

- Click a tab to activate it, ✕ to close it, ⇢ to move it to another / a new group or out of its group.
- Click a group's colour dot to recolour it, its title to rename it, ▾/▸ to collapse or expand it.
- ⋯ on a group: new tab in group, save as snapshot, move to new window / another window, ungroup, close group.
- Toolbar: **By domain** groups the window's tabs by site, **Apply rules** runs your rules over the window, **Save** stores the window as a snapshot. ⋯ offers collapse all / expand all / merge same-name groups.

### Snapshots

- **Save window** stores every tab and group of the current window. Individual groups can be saved from the Groups view or the tab context menu.
- **Restore** recreates the tabs and groups in the current window (tabs load lazily by default). ⋯ offers restore in a new window, update the snapshot from the current window, merge same-name groups, export, delete.
- Expand a snapshot (▸) to rename or recolour its groups, restore a single group, open or remove individual tabs.
- **Export / Import** exchange JSON files. Importing merges by id, so re-importing a file is safe.

### Rules

A rule has a match type, a pattern, a target group title and a colour. Rules are evaluated in order; the first enabled match wins.

| Match type | Pattern |
| --- | --- |
| Domain | Comma-separated domains. `example.com` matches `example.com` and all sub-domains; `*.example.com` matches sub-domains only. |
| URL contains / Title contains | Comma-separated fragments; any match counts. Case-insensitive unless *Case sensitive* is ticked. |
| URL regex / Title regex | A JavaScript regular expression tested against the whole URL / title. |

If the group title is left empty the rule name is used; if that is empty too, the matched domain (or first pattern) becomes the title. Tabs are placed in the existing group with that title in the same window, or a new one is created.

The *Auto-group* toggle at the top turns rule processing on or off without touching the rules. Options such as *skip pinned tabs*, *apply rules at startup* and *ungroup when no rule matches* live on the settings page.

### Keyboard shortcuts

| Default | Action |
| --- | --- |
| Alt+Shift+F | Open the popup |
| Alt+Shift+G | Group selected tab(s) – adds to the current tab's group, or creates a new group |
| Alt+Shift+U | Remove selected tab(s) from their group |
| Alt+Shift+C | Collapse / expand the current group |
| Alt+Shift+D | Auto-group this window by domain |
| Alt+Shift+R | Apply grouping rules to this window |
| Alt+Shift+T | New tab inside the current group |
| *(unset)* | Close current group · Move group to new window · Collapse all · Expand all · Pin/unpin tab · Duplicate tab · Save window snapshot · Next group · Previous group |

Change any of them under **Settings → Keyboard shortcuts** (the extension uses `commands.update`, so no trip to `about:addons` is needed), or via Firefox's *Manage Extension Shortcuts* page.

## Development

```
.
├── manifest.json          # MV3 manifest (Firefox event-page background)
├── background.js          # auto-grouping, shortcuts, snapshots, context menu, message handlers
├── shared/rules.js        # pure logic shared by all pages and the tests (rule matching, normalisation, merging)
├── popup/                 # toolbar popup / full-page manager (Groups, Snapshots, Rules)
├── options/               # settings, shortcut editor, backup / restore
├── icons/icon.svg
└── tests/rules.test.js    # node:test unit tests for shared/rules.js
```

```sh
npm test       # unit tests (Node 18+, no dependencies)
npm run lint   # web-ext lint (downloads web-ext via npx on first run)
npm start      # web-ext run – launches a Firefox profile with the extension loaded
```

## Differences from the Chrome extension

- Firefox has no `tabGroups.create`; groups are created by grouping a tab, so an empty group cannot exist.
- Firefox will not collapse the group that holds the active tab. The extension activates the nearest tab outside the group first; when a window has only one group and no other tabs, collapsing is refused.
- Extensions cannot open privileged URLs (`about:`, `file:`, `moz-extension:` …); such tabs are skipped when a snapshot is restored and counted as "skipped".

## License

MIT
