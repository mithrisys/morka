type ActivityGroup = {
  root: HTMLDetailsElement; title: HTMLSpanElement; meta: HTMLSpanElement; list: HTMLDivElement;
  notice: HTMLParagraphElement; status: ChatActivity["status"]; startedAt?: number; completedAt?: number;
  resultTitle?: string; latest: string; count: number;
};

export class ActivityFeed {
  private readonly groups = new Map<string, ActivityGroup>();
  private readonly entries = new Map<string, { root: HTMLDetailsElement; title: HTMLSpanElement; detail: HTMLPreElement }>();

  constructor(private readonly transcript: HTMLElement) {
    window.setInterval(() => {
      for (const group of this.groups.values()) if (group.status === "running") this.summary(group);
    }, 1000);
  }

  clear() { this.groups.clear(); this.entries.clear(); }

  private summary(group: ActivityGroup) {
    group.root.dataset.status = group.status;
    group.title.textContent = group.status === "running" ? group.latest || "Working…"
      : group.resultTitle ?? "Completed";
    group.title.title = group.title.textContent;
    const elapsed = group.startedAt ? Math.max(0, Math.round(((group.completedAt ?? Date.now()) - group.startedAt) / 1000)) : undefined;
    group.meta.textContent = [group.count ? `${group.count} ${group.count === 1 ? "action" : "actions"}` : "",
      elapsed === undefined ? "" : elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`].filter(Boolean).join(" · ");
  }

  show(message: ChatMessage) {
    const { turnId: id, activity } = message;
    if (!id || !activity) return;
    let group = this.groups.get(id);
    if (!group) {
      const root = document.createElement("details");
      root.className = "turn-activity";
      root.open = activity.status === "running";
      const summary = document.createElement("summary");
      const indicator = document.createElement("span");
      indicator.className = "activity-indicator";
      indicator.setAttribute("aria-hidden", "true");
      const title = document.createElement("span");
      title.className = "activity-title";
      const meta = document.createElement("span");
      meta.className = "activity-meta";
      summary.append(indicator, title, meta);
      const list = document.createElement("div");
      list.className = "activity-list";
      const notice = document.createElement("p");
      notice.className = "activity-notice";
      notice.dir = "auto";
      notice.hidden = true;
      root.append(summary, notice, list);
      this.transcript.append(root);
      group = { root, title, meta, list, notice, count: 0, status: activity.kind === "run" ? activity.status : "completed", latest: "" };
      this.groups.set(id, group);
    }
    if (activity.kind === "run") {
      const finished = group.status === "running" && activity.status !== "running";
      group.status = activity.status;
      group.resultTitle = activity.title;
      group.startedAt = activity.startedAt;
      group.completedAt = activity.completedAt;
      group.notice.textContent = activity.detail ?? "";
      group.notice.hidden = !activity.detail;
      if (finished) group.root.open = false;
    } else {
      let entry = this.entries.get(message.id);
      if (!entry) {
        const root = document.createElement("details");
        root.className = "activity-entry";
        const summary = document.createElement("summary");
        const icon = document.createElement("span");
        icon.className = `icon icon-${{ read: "document", edit: "edit", search: "search", command: "terminal", plan: "document", tool: "shadow" }[activity.kind]}`;
        icon.setAttribute("aria-hidden", "true");
        const title = document.createElement("span");
        const detail = document.createElement("pre");
        detail.className = "activity-detail";
        summary.append(icon, title);
        root.append(summary, detail);
        group.list.append(root);
        entry = { root, title, detail };
        this.entries.set(message.id, entry);
        group.count++;
      }
      entry.root.dataset.status = activity.status;
      entry.title.textContent = activity.title;
      entry.title.title = activity.title;
      entry.detail.textContent = activity.detail ?? "";
      entry.detail.hidden = !activity.detail;
      group.latest = activity.title;
    }
    this.summary(group);
  }
}
