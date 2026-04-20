/*
 * Obsidian Favorites Plugin v1.3.0
 */

"use strict";

var obsidian = require("obsidian");

const VIEW_TYPE_FAVORITES = "favorites-view";
const DEFAULT_DATA = { favorites: [], groups: [] };
const DEFAULT_SETTINGS = { hideExtension: false, frontmatterKey: "" };

// Custom icon: star with a plus in the middle — used for the "Add active file
// to favorites" nav action. Uses currentColor so it inherits theme color
// (hover, active, accent) identically to built-in Lucide icons.
//
// Obsidian's addIcon() wraps this content in an SVG with viewBox="0 0 100 100",
// so the source paths (drawn for a 24x24 viewBox) are scaled up by 100/24.
const FAVORITES_ADD_ICON_ID = "favorites-add";
const FAVORITES_ADD_ICON_SVG = `<g transform="scale(4.166667)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.525 2.295C11.5688 2.20646 11.6365 2.13193 11.7205 2.07983C11.8044 2.02772 11.9012 2.00011 12 2.00011C12.0988 2.00011 12.1956 2.02772 12.2795 2.07983C12.3635 2.13193 12.4312 2.20646 12.475 2.295L14.785 6.974C14.9372 7.28197 15.1618 7.54841 15.4396 7.75045C15.7174 7.9525 16.0401 8.08411 16.38 8.134L21.546 8.89C21.6439 8.90418 21.7358 8.94547 21.8115 9.0092C21.8871 9.07293 21.9434 9.15655 21.974 9.25061C22.0046 9.34466 22.0083 9.44541 21.9846 9.54144C21.9609 9.63747 21.9108 9.72495 21.84 9.794L18.104 13.432C17.8576 13.6721 17.6733 13.9685 17.5668 14.2956C17.4604 14.6228 17.4351 14.9709 17.493 15.31L18.375 20.45C18.3923 20.5478 18.3817 20.6486 18.3445 20.7407C18.3073 20.8328 18.2449 20.9126 18.1645 20.971C18.0842 21.0294 17.989 21.064 17.8899 21.0709C17.7908 21.0778 17.6917 21.0567 17.604 21.01L12.986 18.582C12.6817 18.4222 12.3432 18.3388 11.9995 18.3388C11.6558 18.3388 11.3173 18.4222 11.013 18.582L6.396 21.01C6.30833 21.0564 6.2094 21.0773 6.11045 21.0703C6.0115 21.0632 5.91652 21.0286 5.83629 20.9702C5.75607 20.9119 5.69383 20.8322 5.65666 20.7402C5.61948 20.6483 5.60886 20.5477 5.626 20.45L6.507 15.311C6.5652 14.9717 6.53998 14.6234 6.43354 14.296C6.32709 13.9687 6.14261 13.6722 5.896 13.432L2.16 9.795C2.08859 9.72603 2.03799 9.6384 2.01396 9.54207C1.98993 9.44575 1.99344 9.34462 2.02408 9.25019C2.05472 9.15576 2.11127 9.07184 2.18728 9.00798C2.26329 8.94412 2.3557 8.9029 2.454 8.889L7.619 8.134C7.95926 8.0845 8.28239 7.95306 8.56058 7.75099C8.83878 7.54892 9.0637 7.28227 9.216 6.974L11.525 2.295Z"/><path d="M12 9V15"/><path d="M15 12H9"/></g>`;

// Module-level drag state — persists across view refreshes
let _dragState = null; // { type: "item"|"group", path?: string, fromGroupId?: string|null, id?: string }

function clearDropIndicators() {
  document.querySelectorAll(".fav-drop-top, .fav-drop-bottom, .fav-drop-into")
    .forEach(el => el.classList.remove("fav-drop-top", "fav-drop-bottom", "fav-drop-into"));
}

// ─── Modals ───────────────────────────────────────────────────────────────────

class NewGroupModal extends obsidian.Modal {
  constructor(app, onSubmit) {
    super(app);
    this.onSubmit = onSubmit;
  }
  onOpen() {
    this.titleEl.setText("New group");
    const input = this.contentEl.createEl("input", { type: "text", placeholder: "Group name" });
    input.addClass("favorites-modal-input");
    const btn = this.contentEl.createEl("button", { text: "Create" });
    btn.addClass("mod-cta"); btn.addClass("favorites-modal-btn");
    const submit = () => { const n = input.value.trim(); if (!n) return; this.onSubmit(n); this.close(); };
    btn.addEventListener("click", submit);
    input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
    setTimeout(() => input.focus(), 50);
  }
  onClose() { this.contentEl.empty(); }
}

class RenameGroupModal extends obsidian.Modal {
  constructor(app, currentName, onSubmit) {
    super(app);
    this.currentName = currentName;
    this.onSubmit = onSubmit;
  }
  onOpen() {
    this.titleEl.setText("Rename group");
    const input = this.contentEl.createEl("input", { type: "text" });
    input.addClass("favorites-modal-input");
    input.value = this.currentName;
    const btn = this.contentEl.createEl("button", { text: "Rename" });
    btn.addClass("mod-cta"); btn.addClass("favorites-modal-btn");
    const submit = () => { const n = input.value.trim(); if (!n) return; this.onSubmit(n); this.close(); };
    btn.addEventListener("click", submit);
    input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
    setTimeout(() => { input.select(); input.focus(); }, 50);
  }
  onClose() { this.contentEl.empty(); }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

class FavoritesPlugin extends obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.data = Object.assign({}, DEFAULT_DATA);
    this._writingFrontmatter = false;
  }

  async onload() {
    await this.loadPluginData();
    obsidian.addIcon(FAVORITES_ADD_ICON_ID, FAVORITES_ADD_ICON_SVG);
    this.registerView(VIEW_TYPE_FAVORITES, (leaf) => new FavoritesView(leaf, this));
    this.addRibbonIcon("star", "Open Favorites", () => this.activateView());

    this.addCommand({ id: "toggle-favorite", name: "Toggle favorite for active file", callback: async () => {
      const file = this.app.workspace.getActiveFile();
      if (!file) { new obsidian.Notice("No active file to favorite."); return; }
      await this.toggleFavorite(file);
    }});
    this.addCommand({ id: "add-favorite", name: "Add active file to favorites", callback: async () => {
      const file = this.app.workspace.getActiveFile();
      if (!file) { new obsidian.Notice("No active file."); return; }
      if (this.isFavorite(file)) { new obsidian.Notice(`"${file.name}" is already in favorites.`); return; }
      await this.addFavorite(file);
    }});
    this.addCommand({ id: "open-favorites", name: "Open favorites panel", callback: () => this.activateView() });
    this.addSettingTab(new FavoritesSettingTab(this.app, this));
    this.addCommand({ id: "remove-favorite", name: "Remove active file from favorites", callback: async () => {
      const file = this.app.workspace.getActiveFile();
      if (!file) { new obsidian.Notice("No active file."); return; }
      if (!this.isFavorite(file)) { new obsidian.Notice(`"${file.name}" is not in favorites.`); return; }
      await this.removeFavorite(file);
    }});

    this.registerEvent(this.app.vault.on("rename", (f, op) => this.handleRename(f, op)));
    this.registerEvent(this.app.vault.on("delete", f => this.handleDelete(f)));
    this.registerEvent(this.app.metadataCache.on("changed", f => this.handleMetadataChange(f)));

    // ── View-actions star button ───────────────────────────────────────────
    this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => {
      if (leaf) this._injectStarButton(leaf);
    }));
    this.registerEvent(this.app.workspace.on("layout-change", () => {
      this._injectAllStarButtons();
    }));
    this.registerEvent(this.app.workspace.on("file-open", () => {
      this._refreshAllStarBtns();
    }));

    this.app.workspace.onLayoutReady(() => {
      this._injectAllStarButtons();
    });
  }

  // ── View-actions star button ───────────────────────────────────────────────

  _injectAllStarButtons() {
    this.app.workspace.iterateAllLeaves(leaf => this._injectStarButton(leaf));
  }

  _injectStarButton(leaf) {
    const view = leaf?.view;
    if (!view?.file || typeof view.addAction !== "function") return;
    if (view.getViewType() === VIEW_TYPE_FAVORITES) return;

    // Re-use existing button if already injected for this view
    const actionsEl = view.containerEl?.parentElement?.querySelector(".view-actions");
    if (!actionsEl) return;
    const existing = actionsEl.querySelector(".favorites-star-btn");
    if (existing) { this._refreshStarBtn(existing, view.file); return; }

    const btn = view.addAction("star", "Toggle favorite", async () => {
      const f = leaf.view?.file;
      if (f) await this.toggleFavorite(f);
    });
    btn.addClass("favorites-star-btn");
    this._refreshStarBtn(btn, view.file);
  }

  _refreshStarBtn(btn, file) {
    const isFav = this.isFavorite(file);
    btn.toggleClass("mod-bookmarked", isFav);
    obsidian.setIcon(btn, "star");
    btn.setAttribute("aria-label", isFav ? "Remove from favorites" : "Add to favorites");
  }

  _refreshAllStarBtns() {
    this.app.workspace.iterateAllLeaves(leaf => {
      const view = leaf?.view;
      if (!view?.file) return;
      const actionsEl = view.containerEl?.parentElement?.querySelector(".view-actions");
      if (!actionsEl) return;
      const btn = actionsEl.querySelector(".favorites-star-btn");
      if (btn) this._refreshStarBtn(btn, view.file);
    });
  }

  // ── Data ──────────────────────────────────────────────────────────────────

  async loadPluginData() {
    const saved = await this.loadData();
    this.data = Object.assign({ favorites: [], groups: [] }, saved);
    if (!Array.isArray(this.data.groups)) this.data.groups = [];
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved?.settings ?? {});
  }

  async savePluginData() {
    await this.saveData(Object.assign({}, this.data, { settings: this.settings }));
    this.refreshView();
    this._refreshAllStarBtns();
  }

  async saveSettings() {
    await this.saveData(Object.assign({}, this.data, { settings: this.settings }));
    this.refreshView();
  }

  // ── Favorites ─────────────────────────────────────────────────────────────

  isFavorite(file) {
    const path = typeof file === "string" ? file : file.path;
    return this.data.favorites.includes(path) || this.data.groups.some(g => g.items.includes(path));
  }

  async toggleFavorite(file) {
    this.isFavorite(file) ? await this.removeFavorite(file) : await this.addFavorite(file);
  }

  async addFavorite(file) {
    this.data.favorites.push(file.path);
    await this.savePluginData();
    if (file instanceof obsidian.TFile && file.extension === "md") await this.writeFrontmatterFavorite(file, true);
    new obsidian.Notice(`⭐ Added "${file.name}" to favorites.`);
  }

  async removeFavorite(file) {
    const path = file.path;
    this.data.favorites = this.data.favorites.filter(p => p !== path);
    this.data.groups.forEach(g => { g.items = g.items.filter(p => p !== path); });
    await this.savePluginData();
    if (file instanceof obsidian.TFile && file.extension === "md") await this.writeFrontmatterFavorite(file, false);
    new obsidian.Notice(`Removed "${file.name}" from favorites.`);
  }

  async writeFrontmatterFavorite(file, isFav) {
    this._writingFrontmatter = true;
    try {
      await this.app.fileManager.processFrontMatter(file, fm => {
        if (isFav) { fm["favorite"] = "yes"; } else { delete fm["favorite"]; }
      });
    } finally {
      setTimeout(() => { this._writingFrontmatter = false; }, 300);
    }
  }

  // ── Groups ────────────────────────────────────────────────────────────────

  async createGroup(name) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    this.data.groups.push({ id, name, collapsed: false, items: [] });
    await this.savePluginData();
  }

  async deleteGroup(id) {
    const group = this.data.groups.find(g => g.id === id);
    if (!group) return;
    group.items.forEach(p => { if (!this.data.favorites.includes(p)) this.data.favorites.push(p); });
    this.data.groups = this.data.groups.filter(g => g.id !== id);
    await this.savePluginData();
  }

  async renameGroup(id, name) {
    const g = this.data.groups.find(g => g.id === id);
    if (g) { g.name = name; await this.savePluginData(); }
  }

  async toggleGroupCollapsed(id) {
    const g = this.data.groups.find(g => g.id === id);
    if (g) { g.collapsed = !g.collapsed; await this.savePluginData(); }
  }

  async setAllGroupsCollapsed(collapsed) {
    this.data.groups.forEach(g => g.collapsed = collapsed);
    await this.savePluginData();
  }

  async moveItemToGroup(filePath, groupId) {
    this.data.favorites = this.data.favorites.filter(p => p !== filePath);
    this.data.groups.forEach(g => { if (g.id !== groupId) g.items = g.items.filter(p => p !== filePath); });
    const group = this.data.groups.find(g => g.id === groupId);
    if (group && !group.items.includes(filePath)) group.items.push(filePath);
    await this.savePluginData();
  }

  async moveItemToUngrouped(filePath) {
    this.data.groups.forEach(g => { g.items = g.items.filter(p => p !== filePath); });
    if (!this.data.favorites.includes(filePath)) this.data.favorites.push(filePath);
    await this.savePluginData();
  }

  // ── Drag and drop data mutations ──────────────────────────────────────────

  /** Move an item relative to another item (before/after), across any container. */
  async moveItemRelativeToItem(fromPath, fromGroupId, toPath, toGroupId, position) {
    if (fromPath === toPath) return;

    const getArr = (gId) => gId === null
      ? this.data.favorites
      : (this.data.groups.find(g => g.id === gId)?.items ?? null);

    const fromArr = getArr(fromGroupId);
    const toArr   = getArr(toGroupId);
    if (!fromArr || !toArr) return;

    // Remove from source
    const fromIdx = fromArr.indexOf(fromPath);
    if (fromIdx === -1) return;
    fromArr.splice(fromIdx, 1);

    // Insert into destination relative to toPath
    const toIdx = toArr.indexOf(toPath);
    if (toIdx === -1) {
      toArr.push(fromPath);
    } else {
      const insertAt = position === "before" ? toIdx : toIdx + 1;
      toArr.splice(insertAt, 0, fromPath);
    }

    await this.savePluginData();
  }

  /** Move an item to the end of a group's items list. */
  async moveItemToGroupEnd(fromPath, toGroupId) {
    // Strip from all current locations
    this.data.favorites = this.data.favorites.filter(p => p !== fromPath);
    this.data.groups.forEach(g => { g.items = g.items.filter(p => p !== fromPath); });
    const group = this.data.groups.find(g => g.id === toGroupId);
    if (group) group.items.push(fromPath);
    await this.savePluginData();
  }

  /** Move an item to the end of the ungrouped list. */
  async moveItemToUngroupedEnd(fromPath) {
    this.data.favorites = this.data.favorites.filter(p => p !== fromPath);
    this.data.groups.forEach(g => { g.items = g.items.filter(p => p !== fromPath); });
    this.data.favorites.push(fromPath);
    await this.savePluginData();
  }

  /** Reorder a group relative to another group (before/after). */
  async reorderGroup(fromId, toId, position) {
    if (fromId === toId) return;
    const fromIdx = this.data.groups.findIndex(g => g.id === fromId);
    if (fromIdx === -1) return;
    const [moving] = this.data.groups.splice(fromIdx, 1);
    const toIdx = this.data.groups.findIndex(g => g.id === toId);
    if (toIdx === -1) { this.data.groups.push(moving); return; }
    const insertAt = position === "before" ? toIdx : toIdx + 1;
    this.data.groups.splice(insertAt, 0, moving);
    await this.savePluginData();
  }

  // ── Vault events ──────────────────────────────────────────────────────────

  async handleRename(file, oldPath) {
    let changed = false;
    const idx = this.data.favorites.indexOf(oldPath);
    if (idx !== -1) { this.data.favorites[idx] = file.path; changed = true; }
    this.data.groups.forEach(g => {
      const gi = g.items.indexOf(oldPath);
      if (gi !== -1) { g.items[gi] = file.path; changed = true; }
    });
    if (changed) await this.savePluginData();
  }

  async handleDelete(file) {
    const before = this.data.favorites.length;
    this.data.favorites = this.data.favorites.filter(p => p !== file.path);
    let changed = this.data.favorites.length !== before;
    this.data.groups.forEach(g => {
      const b = g.items.length;
      g.items = g.items.filter(p => p !== file.path);
      if (g.items.length !== b) changed = true;
    });
    if (changed) await this.savePluginData();
  }

  async handleMetadataChange(file) {
    if (this._writingFrontmatter) return;
    const cache = this.app.metadataCache.getFileCache(file);
    const raw = cache?.frontmatter?.["favorite"];
    const markedFav   = raw === true  || raw === "yes"  || raw === "true";
    const markedUnfav = raw === false || raw === "no"   || raw === "false";
    const currentlyFav = this.isFavorite(file);
    if (markedFav && !currentlyFav) {
      this.data.favorites.push(file.path);
      await this.saveData(this.data); this.refreshView();
      new obsidian.Notice(`⭐ "${file.name}" added to favorites via frontmatter.`);
    } else if (markedUnfav && currentlyFav) {
      this.data.favorites = this.data.favorites.filter(p => p !== file.path);
      this.data.groups.forEach(g => { g.items = g.items.filter(p => p !== file.path); });
      await this.saveData(this.data); this.refreshView();
      new obsidian.Notice(`"${file.name}" removed from favorites via frontmatter.`);
    }
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_FAVORITES)[0];
    if (!leaf) {
      const newLeaf = workspace.getLeftLeaf(false);
      if (!newLeaf) return;
      await newLeaf.setViewState({ type: VIEW_TYPE_FAVORITES, active: true });
      leaf = newLeaf;
    }
    workspace.revealLeaf(leaf);
  }

  refreshView() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_FAVORITES).forEach(leaf => {
      if (leaf.view instanceof FavoritesView) leaf.view.refresh();
    });
  }
}

// ─── Sidebar View ─────────────────────────────────────────────────────────────

class FavoritesView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType()    { return VIEW_TYPE_FAVORITES; }
  getDisplayText() { return "Favorites"; }
  getIcon()        { return "star"; }

  async onOpen() {
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refresh()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.refresh()));
    this._buildNav();
    this.refresh();
  }
  async onClose() {}

  // Build the nav-header once at the workspace-leaf-content level, matching
  // core plugins (bookmarks, etc.) which place nav-header as a direct child
  // of workspace-leaf-content — not inside view-content.
  _buildNav() {
    if (this.containerEl.querySelector(".favorites-nav-header")) return;

    const navHeader = this.containerEl.createEl("div", { cls: "nav-header favorites-nav-header" });
    this.containerEl.prepend(navHeader); // before view-header, matching core structure

    const nav = navHeader.createEl("div", { cls: "nav-buttons-container" });

    const addBtn = nav.createEl("div", { cls: "clickable-icon nav-action-button" });
    obsidian.setTooltip(addBtn, "Add active file to favorites");
    obsidian.setIcon(addBtn, FAVORITES_ADD_ICON_ID);
    addBtn.addEventListener("click", async () => {
      const file = this.app.workspace.getActiveFile();
      if (!file) { new obsidian.Notice("No active file."); return; }
      if (this.plugin.isFavorite(file)) { new obsidian.Notice(`"${file.name}" is already in favorites.`); return; }
      await this.plugin.addFavorite(file);
    });

    const groupBtn = nav.createEl("div", { cls: "clickable-icon nav-action-button" });
    obsidian.setTooltip(groupBtn, "New group");
    obsidian.setIcon(groupBtn, "folder-plus");
    groupBtn.addEventListener("click", () => {
      new NewGroupModal(this.app, async name => await this.plugin.createGroup(name)).open();
    });

    const collapseBtn = nav.createEl("div", { cls: "clickable-icon nav-action-button" });
    const updateCollapseBtn = () => {
      const anyExpanded = this.plugin.data.groups.some(g => !g.collapsed);
      obsidian.setIcon(collapseBtn, anyExpanded ? "chevrons-down-up" : "chevrons-up-down");
      obsidian.setTooltip(collapseBtn, anyExpanded ? "Collapse all" : "Expand all");
    };
    updateCollapseBtn();
    collapseBtn.addEventListener("click", async () => {
      const anyExpanded = this.plugin.data.groups.some(g => !g.collapsed);
      await this.plugin.setAllGroupsCollapsed(anyExpanded);
      updateCollapseBtn();
    });
  }

  refresh() {
    const root = this.containerEl.querySelector(".view-content");
    if (!root) return;
    root.empty();
    root.addClass("favorites-root");

    // ── List ─────────────────────────────────────────────────────────────
    const list = root.createEl("div", { cls: "favorites-list" });

    const hasAny = this.plugin.data.favorites.length > 0 || this.plugin.data.groups.length > 0;
    if (!hasAny) {
      const empty = list.createEl("div", { cls: "favorites-empty" });
      empty.createEl("div", { cls: "favorites-empty-icon", text: "☆" });
      empty.createEl("div", { cls: "favorites-empty-text", text: "No favorites yet." });
      empty.createEl("div", { cls: "favorites-empty-hint", text: "Open a file and use the button above or the command palette." });
      return;
    }

    // Ungrouped items
    this.plugin.data.favorites.forEach(filePath => {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!file) return;
      this.renderItem(list, file, filePath, null);
    });

    // Groups
    this.plugin.data.groups.forEach(group => this.renderGroup(list, group));

    // Drop zone at the very bottom (for dragging items to end of ungrouped)
    this.attachListDropZone(list);
  }

  // ── Drop zone on the list container itself ────────────────────────────────

  attachListDropZone(list) {
    list.addEventListener("dragover", e => {
      if (!_dragState || _dragState.type !== "item") return;
      // Only act if we're directly over the list, not over a child
      const target = e.target;
      if (target === list) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        clearDropIndicators();
        list.classList.add("fav-drop-list");
      }
    });
    list.addEventListener("dragleave", e => {
      if (!list.contains(e.relatedTarget)) list.classList.remove("fav-drop-list");
    });
    list.addEventListener("drop", async e => {
      if (!_dragState || _dragState.type !== "item") return;
      if (e.target !== list) return;
      e.preventDefault();
      list.classList.remove("fav-drop-list");
      await this.plugin.moveItemToUngroupedEnd(_dragState.path);
    });
  }

  // ── Display name resolution ───────────────────────────────────────────────
  //
  // Priority: frontmatter key value → file.basename (hideExtension) → file.name
  getDisplayName(file) {
    const { frontmatterKey, hideExtension } = this.plugin.settings;

    // Frontmatter override (markdown files only)
    if (frontmatterKey && file instanceof obsidian.TFile && file.extension === "md") {
      const cache = this.app.metadataCache.getFileCache(file);
      const val = cache?.frontmatter?.[frontmatterKey];
      if (val !== undefined && val !== null && String(val).trim() !== "") {
        return String(val).trim();
      }
    }

    // Extension toggle
    if (hideExtension && file instanceof obsidian.TFile) {
      return file.basename;
    }

    return file.name;
  }

  // ── Iconic integration ────────────────────────────────────────────────────
  //
  // Returns { icon, color } from the Iconic plugin for the given file, or null.
  // Tries several access patterns because Iconic's internal structure may vary
  // across versions. Falls back to reading data.json if the live plugin data
  // isn't accessible.
  getIconicEntry(file) {
    try {
      // Icons are stored at iconic.settings.fileIcons[filePath]
      const entry = this.app.plugins?.plugins?.["iconic"]?.settings?.fileIcons?.[file.path];
      if (entry?.icon) return entry;
    } catch (_) {}
    return null;
  }

  // ── Group ─────────────────────────────────────────────────────────────────

  renderGroup(container, group) {
    const groupEl = container.createEl("div", { cls: "favorites-group tree-item" });
    groupEl.dataset.groupId = group.id;

    // ── Group header ──────────────────────────────────────────────────────
    const headerEl = groupEl.createEl("div", { cls: "favorites-group-header tree-item-self is-clickable mod-collapsible" });

    // Drag handle on the header
    headerEl.setAttribute("draggable", "true");

    headerEl.addEventListener("dragstart", e => {
      _dragState = { type: "group", id: group.id };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", group.id);
      setTimeout(() => groupEl.classList.add("fav-dragging"), 0);
    });

    headerEl.addEventListener("dragend", () => {
      groupEl.classList.remove("fav-dragging");
      _dragState = null;
      clearDropIndicators();
    });

    headerEl.addEventListener("dragover", e => {
      if (!_dragState) return;
      e.preventDefault();
      clearDropIndicators();

      if (_dragState.type === "item") {
        // Hovering item over group header → drop into group
        e.dataTransfer.dropEffect = "move";
        headerEl.classList.add("fav-drop-into");
      } else if (_dragState.type === "group" && _dragState.id !== group.id) {
        // Reordering groups
        e.dataTransfer.dropEffect = "move";
        const mid = headerEl.getBoundingClientRect().top + headerEl.getBoundingClientRect().height / 2;
        headerEl.classList.add(e.clientY < mid ? "fav-drop-top" : "fav-drop-bottom");
      }
    });

    headerEl.addEventListener("dragleave", e => {
      if (!headerEl.contains(e.relatedTarget)) {
        headerEl.classList.remove("fav-drop-top", "fav-drop-bottom", "fav-drop-into");
      }
    });

    headerEl.addEventListener("drop", async e => {
      e.preventDefault();
      clearDropIndicators();
      if (!_dragState) return;

      if (_dragState.type === "item") {
        await this.plugin.moveItemToGroupEnd(_dragState.path, group.id);
      } else if (_dragState.type === "group" && _dragState.id !== group.id) {
        const mid = headerEl.getBoundingClientRect().top + headerEl.getBoundingClientRect().height / 2;
        await this.plugin.reorderGroup(_dragState.id, group.id, e.clientY < mid ? "before" : "after");
      }
    });

    // Collapse arrow
    const arrowEl = headerEl.createEl("div", { cls: "tree-item-icon collapse-icon favorites-group-arrow" });
    if (group.collapsed) arrowEl.classList.add("is-collapsed");
    obsidian.setIcon(arrowEl, "chevron-down");

    // Folder icon
    const folderIconEl = headerEl.createEl("div", { cls: "tree-item-icon favorites-group-folder-icon" });
    obsidian.setIcon(folderIconEl, group.collapsed ? "folder" : "folder-open");

    // Group name
    headerEl.createEl("span", { cls: "tree-item-inner favorites-group-name", text: group.name });

    // Toggle collapse — use mouseup for the same reason as item open:
    // draggable="true" on this element causes Chromium to delay/suppress click.
    headerEl.addEventListener("mouseup", async e => {
      if (e.button !== 0 || _dragState) return;
      await this.plugin.toggleGroupCollapsed(group.id);
    });

    // Right-click menu
    headerEl.addEventListener("contextmenu", e => {
      e.preventDefault();
      const menu = new obsidian.Menu();
      menu.addItem(mi => mi.setTitle("Rename group").setIcon("pencil").onClick(() => {
        new RenameGroupModal(this.app, group.name, async name => await this.plugin.renameGroup(group.id, name)).open();
      }));
      menu.addItem(mi => mi.setTitle("Delete group").setIcon("trash-2").onClick(async () => {
        await this.plugin.deleteGroup(group.id);
      }));
      menu.showAtMouseEvent(e);
    });

    // ── Group items ───────────────────────────────────────────────────────
    if (!group.collapsed) {
      const itemsEl = groupEl.createEl("div", { cls: "tree-item-children favorites-group-items" });
      if (group.items.length === 0) {
        const emptyEl = itemsEl.createEl("div", { cls: "favorites-group-empty", text: "Empty group" });
        // Allow dropping onto empty group body
        emptyEl.addEventListener("dragover", e => {
          if (!_dragState || _dragState.type !== "item") return;
          e.preventDefault();
          clearDropIndicators();
          emptyEl.classList.add("fav-drop-into");
        });
        emptyEl.addEventListener("dragleave", () => emptyEl.classList.remove("fav-drop-into"));
        emptyEl.addEventListener("drop", async e => {
          e.preventDefault();
          clearDropIndicators();
          if (_dragState?.type === "item") await this.plugin.moveItemToGroupEnd(_dragState.path, group.id);
        });
      } else {
        group.items.forEach(filePath => {
          const file = this.app.vault.getAbstractFileByPath(filePath);
          if (!file) return;
          this.renderItem(itemsEl, file, filePath, group.id);
        });
      }
    }
  }

  // ── Item ──────────────────────────────────────────────────────────────────

  renderItem(container, file, filePath, groupId) {
    const activeFile = this.app.workspace.getActiveFile();
    const isActive = activeFile?.path === filePath;

    // Outer tree-item — matches the structure bookmarks/file-explorer use.
    // Drag state lives here so drop indicators apply to the whole row unit.
    const treeItem = container.createEl("div", { cls: "tree-item" });
    treeItem.setAttribute("draggable", "true");
    treeItem.dataset.path = filePath;

    // The visible interactive row. favorites-item is the minimal hook for our
    // unique additions (grab cursor, remove-btn visibility). Core tree-item-self
    // handles padding, hover, active, border-radius.
    const item = treeItem.createEl("div", {
      cls: "tree-item-self is-clickable favorites-item" + (isActive ? " is-active" : "")
    });

    // ── Drag events (on the outer tree-item) ──────────────────────────────

    treeItem.addEventListener("dragstart", e => {
      _dragState = { type: "item", path: filePath, fromGroupId: groupId };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", filePath);
      setTimeout(() => treeItem.classList.add("fav-dragging"), 0);
    });

    treeItem.addEventListener("dragend", () => {
      treeItem.classList.remove("fav-dragging");
      _dragState = null;
      clearDropIndicators();
    });

    treeItem.addEventListener("dragover", e => {
      if (!_dragState || _dragState.type !== "item" || _dragState.path === filePath) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      clearDropIndicators();
      const mid = treeItem.getBoundingClientRect().top + treeItem.getBoundingClientRect().height / 2;
      treeItem.classList.add(e.clientY < mid ? "fav-drop-top" : "fav-drop-bottom");
    });

    treeItem.addEventListener("dragleave", e => {
      if (!treeItem.contains(e.relatedTarget)) {
        treeItem.classList.remove("fav-drop-top", "fav-drop-bottom");
      }
    });

    treeItem.addEventListener("drop", async e => {
      e.preventDefault();
      clearDropIndicators();
      if (!_dragState || _dragState.type !== "item" || _dragState.path === filePath) return;
      const mid = treeItem.getBoundingClientRect().top + treeItem.getBoundingClientRect().height / 2;
      const position = e.clientY < mid ? "before" : "after";
      await this.plugin.moveItemRelativeToItem(_dragState.path, _dragState.fromGroupId, filePath, groupId, position);
    });

    // ── Content ───────────────────────────────────────────────────────────

    // tree-item-icon: core CSS positions this absolutely within tree-item-self,
    // identical to how bookmarks/file-explorer render icons.
    const iconEl = item.createEl("div", { cls: "tree-item-icon" });
    const iconicEntry = file instanceof obsidian.TFile ? this.getIconicEntry(file) : null;
    if (iconicEntry?.icon) {
      if (/^[a-z0-9-]+$/.test(iconicEntry.icon)) {
        obsidian.setIcon(iconEl, iconicEntry.icon);
      } else {
        iconEl.textContent = iconicEntry.icon; // emoji
      }
      if (iconicEntry.color) iconEl.style.color = iconicEntry.color;
    } else {
      const ext = file instanceof obsidian.TFile ? file.extension.toLowerCase() : "";
      const iconName = (
        ext === "md"                                               ? "file-text" :
        ["png","jpg","jpeg","gif","svg","webp","bmp"].includes(ext) ? "image"    :
        ["mp3","wav","ogg","flac","m4a"].includes(ext)             ? "music"     :
        ["mp4","mov","avi","mkv","webm"].includes(ext)             ? "video"     :
        ext === "pdf"                                              ? "file-text" :
        "file"
      );
      obsidian.setIcon(iconEl, iconName);
    }

    // tree-item-inner: core handles text truncation and left indent to clear
    // the absolutely-positioned icon — same as bookmarks/file-explorer.
    const inner = item.createEl("div", { cls: "tree-item-inner" });
    inner.setText(this.getDisplayName(file));

    // Use mouseup instead of click — draggable="true" on the ancestor causes
    // Chromium to delay/suppress click events for drag disambiguation.
    // mouseup fires immediately on mouse release and is NOT dispatched during
    // an active HTML5 drag operation, so it naturally ignores drags.
    item.addEventListener("mouseup", async e => {
      if (e.button !== 0 || _dragState) return; // left-button only, skip if drag active
      if (file instanceof obsidian.TFile) await this.app.workspace.getLeaf(false).openFile(file);
    });

    // ── Context menu ──────────────────────────────────────────────────────

    item.addEventListener("contextmenu", e => {
      e.preventDefault();
      const menu = new obsidian.Menu();
      menu.addItem(mi => mi.setTitle("Open").setIcon("file-open").onClick(async () => {
        if (file instanceof obsidian.TFile) await this.app.workspace.getLeaf(false).openFile(file);
      }));
      menu.addItem(mi => mi.setTitle("Open in new tab").setIcon("file-plus").onClick(async () => {
        if (file instanceof obsidian.TFile) await this.app.workspace.getLeaf(true).openFile(file);
      }));
      menu.addSeparator();
      if (this.plugin.data.groups.length > 0) {
        this.plugin.data.groups.forEach(g => {
          if (g.id !== groupId) {
            menu.addItem(mi => mi.setTitle(`Move to "${g.name}"`).setIcon("folder")
              .onClick(async () => await this.plugin.moveItemToGroup(filePath, g.id)));
          }
        });
        if (groupId !== null) {
          menu.addItem(mi => mi.setTitle("Remove from group").setIcon("folder-minus")
            .onClick(async () => await this.plugin.moveItemToUngrouped(filePath)));
        }
        menu.addSeparator();
      }
      menu.addItem(mi => mi.setTitle("Remove from favorites").setIcon("star-off")
        .onClick(async () => await this.plugin.removeFavorite(file)));
      menu.showAtMouseEvent(e);
    });
  }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class FavoritesSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new obsidian.Setting(containerEl)
      .setName("Hide file extensions")
      .setDesc("When enabled, file extensions (.md, .pdf, etc.) are hidden in the favorites list.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.hideExtension)
        .onChange(async value => {
          this.plugin.settings.hideExtension = value;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName("Display name frontmatter key")
      .setDesc("Show a frontmatter value instead of the file name. Enter the key you use, e.g. \"title\". Leave blank to use the file name.")
      .addText(text => text
        .setPlaceholder("e.g. title")
        .setValue(this.plugin.settings.frontmatterKey)
        .onChange(async value => {
          this.plugin.settings.frontmatterKey = value.trim();
          await this.plugin.saveSettings();
        })
      );
  }
}

module.exports = FavoritesPlugin;
