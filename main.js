/*
 * Obsidian Favorites Plugin v1.2.0
 */

"use strict";

var obsidian = require("obsidian");

const VIEW_TYPE_FAVORITES = "favorites-view";
const DEFAULT_DATA = { favorites: [], groups: [] };

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
    this.addCommand({ id: "remove-favorite", name: "Remove active file from favorites", callback: async () => {
      const file = this.app.workspace.getActiveFile();
      if (!file) { new obsidian.Notice("No active file."); return; }
      if (!this.isFavorite(file)) { new obsidian.Notice(`"${file.name}" is not in favorites.`); return; }
      await this.removeFavorite(file);
    }});

    this.registerEvent(this.app.vault.on("rename", (f, op) => this.handleRename(f, op)));
    this.registerEvent(this.app.vault.on("delete", f => this.handleDelete(f)));
    this.registerEvent(this.app.metadataCache.on("changed", f => this.handleMetadataChange(f)));
    this.app.workspace.onLayoutReady(() => this.activateView());
  }

  // ── Data ──────────────────────────────────────────────────────────────────

  async loadPluginData() {
    const saved = await this.loadData();
    this.data = Object.assign({ favorites: [], groups: [] }, saved);
    if (!Array.isArray(this.data.groups)) this.data.groups = [];
  }

  async savePluginData() {
    await this.saveData(this.data);
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

  async onOpen()  { this.refresh(); }
  async onClose() {}

  refresh() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("favorites-root");

    // ── Nav buttons ──────────────────────────────────────────────────────
    const nav = root.createEl("div", { cls: "nav-buttons-container" });

    const addBtn = nav.createEl("div", { cls: "clickable-icon nav-action-button", title: "Add active file to favorites" });
    obsidian.setIcon(addBtn, "bookmark-plus");
    addBtn.addEventListener("click", async () => {
      const file = this.app.workspace.getActiveFile();
      if (!file) { new obsidian.Notice("No active file."); return; }
      if (this.plugin.isFavorite(file)) { new obsidian.Notice(`"${file.name}" is already in favorites.`); return; }
      await this.plugin.addFavorite(file);
    });

    const groupBtn = nav.createEl("div", { cls: "clickable-icon nav-action-button", title: "Create new group" });
    obsidian.setIcon(groupBtn, "folder-plus");
    groupBtn.addEventListener("click", () => {
      new NewGroupModal(this.app, async name => await this.plugin.createGroup(name)).open();
    });

    const collapseBtn = nav.createEl("div", { cls: "clickable-icon nav-action-button", title: "Collapse/expand all groups" });
    obsidian.setIcon(collapseBtn, "chevrons-up-down");
    collapseBtn.addEventListener("click", async () => {
      const anyExpanded = this.plugin.data.groups.some(g => !g.collapsed);
      await this.plugin.setAllGroupsCollapsed(anyExpanded);
    });

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

    // Toggle collapse (prevent triggering on drag)
    headerEl.addEventListener("click", async e => {
      if (e.defaultPrevented) return;
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
    const item = container.createEl("div", { cls: "favorites-item" });
    item.setAttribute("draggable", "true");
    item.dataset.path = filePath;

    // ── Drag events ───────────────────────────────────────────────────────

    item.addEventListener("dragstart", e => {
      _dragState = { type: "item", path: filePath, fromGroupId: groupId };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", filePath);
      setTimeout(() => item.classList.add("fav-dragging"), 0);
    });

    item.addEventListener("dragend", () => {
      item.classList.remove("fav-dragging");
      _dragState = null;
      clearDropIndicators();
    });

    item.addEventListener("dragover", e => {
      if (!_dragState || _dragState.type !== "item" || _dragState.path === filePath) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      clearDropIndicators();
      const mid = item.getBoundingClientRect().top + item.getBoundingClientRect().height / 2;
      item.classList.add(e.clientY < mid ? "fav-drop-top" : "fav-drop-bottom");
    });

    item.addEventListener("dragleave", e => {
      if (!item.contains(e.relatedTarget)) {
        item.classList.remove("fav-drop-top", "fav-drop-bottom");
      }
    });

    item.addEventListener("drop", async e => {
      e.preventDefault();
      clearDropIndicators();
      if (!_dragState || _dragState.type !== "item" || _dragState.path === filePath) return;
      const mid = item.getBoundingClientRect().top + item.getBoundingClientRect().height / 2;
      const position = e.clientY < mid ? "before" : "after";
      await this.plugin.moveItemRelativeToItem(_dragState.path, _dragState.fromGroupId, filePath, groupId, position);
    });

    // ── Content ───────────────────────────────────────────────────────────

    // File icon — prefer Iconic plugin, fall back to file-type defaults
    const iconEl = item.createEl("div", { cls: "tree-item-icon favorites-item-icon" });
    const iconicEntry = file instanceof obsidian.TFile ? this.getIconicEntry(file) : null;
    if (iconicEntry?.icon) {
      // Iconic icons are either Lucide names (kebab-case) or raw emoji/unicode
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

    const name = item.createEl("span", { cls: "favorites-item-name", text: file.name });
    name.setAttribute("title", filePath);
    name.addEventListener("click", async e => {
      e.stopPropagation();
      if (file instanceof obsidian.TFile) await this.app.workspace.getLeaf(false).openFile(file);
    });

    const removeBtn = item.createEl("div", { cls: "favorites-remove-btn clickable-icon", title: "Remove from favorites" });
    obsidian.setIcon(removeBtn, "x");
    removeBtn.addEventListener("click", async e => {
      e.stopPropagation();
      await this.plugin.removeFavorite(file);
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

module.exports = FavoritesPlugin;
