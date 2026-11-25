(() => {
  if (new URLSearchParams(location.search).get("scope") === "shadow") return;
  const create = document.querySelector<HTMLButtonElement>("#new-app");
  const clone = document.querySelector<HTMLButtonElement>("#clone-app");
  const notice = document.querySelector<HTMLElement>("#app-install-status");
  const wake = document.querySelector<HTMLButtonElement>("#wake-project");
  if (wake) {
    const dialog = document.querySelector<HTMLDialogElement>("#wake-dialog")!;
    const form = dialog.querySelector("form")!;
    const folder = dialog.querySelector<HTMLButtonElement>("#wake-folder")!;
    const archive = dialog.querySelector<HTMLButtonElement>("#wake-archive")!;
    const gitUrl = dialog.querySelector<HTMLInputElement>("#wake-git-url")!;
    const cancel = dialog.querySelector<HTMLButtonElement>("#wake-cancel")!;
    const status = dialog.querySelector<HTMLElement>("#wake-status")!;
    const controls = Array.from(dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button"));
    let waking = false;
    async function wakeProject(kind: ProjectSourceKind) {
      if (waking) return;
      const focused = document.activeElement as HTMLElement | null;
      waking = true;
      for (const control of controls) control.disabled = true;
      status.textContent = kind === "git" ? "Cloning and launching project…" : "Preparing project…";
      status.hidden = false;
      try {
        const result = await window.lab.wakeProject(kind, kind === "git" ? gitUrl.value : undefined);
        if (result) status.textContent = result.error;
        else status.hidden = true;
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        waking = false;
        for (const control of controls) control.disabled = false;
        focused?.focus();
      }
    }
    wake.addEventListener("click", () => {
      status.hidden = true;
      dialog.showModal();
    });
    folder.addEventListener("click", () => void wakeProject("folder"));
    archive.addEventListener("click", () => void wakeProject("archive"));
    form.addEventListener("submit", event => {
      event.preventDefault();
      void wakeProject("git");
    });
    cancel.addEventListener("click", () => dialog.close());
    dialog.addEventListener("cancel", event => { if (waking) event.preventDefault(); });
  }
  const modal = document.createElement("dialog");
  modal.className = "app-setup";
  modal.setAttribute("aria-labelledby", "app-setup-title");
  modal.innerHTML = `
    <form>
      <h2 id="app-setup-title"></h2>
      <label for="app-name">App name</label>
      <input id="app-name" type="text" maxlength="72" required autofocus>
      <span id="app-setup-status" role="status" hidden></span>
      <div class="setup-actions">
        <button type="button" class="app-button setup-cancel">Cancel</button>
        <button type="submit" class="app-button primary">Choose Folder…</button>
      </div>
    </form>`;
  document.body.append(modal);
  modal.querySelector("h2")!.textContent = create ? "Name your morka" : "Clone app";
  const name = modal.querySelector<HTMLInputElement>("input")!;
  const form = modal.querySelector("form")!;
  const cancel = modal.querySelector<HTMLButtonElement>(".setup-cancel")!;
  const submit = modal.querySelector<HTMLButtonElement>("[type=submit]")!;
  const status = modal.querySelector<HTMLElement>("#app-setup-status")!;
  let appTitle = "";
  let running = false;

  if (clone) {
    void window.lab.currentApp().then(installedName => {
      if (!installedName) return;
      appTitle = installedName;
      const wordmark = document.querySelector<HTMLElement>(".wordmark")!;
      wordmark.textContent = appTitle;
      wordmark.title = appTitle;
      document.title = appTitle;
      clone.hidden = false;
    }).catch(console.error);
  }
  cancel.addEventListener("click", () => modal.close());
  modal.addEventListener("cancel", event => { if (running) event.preventDefault(); });
  function openSetup() {
    if (modal.open || running) return;
    if (notice) notice.hidden = true;
    status.hidden = true;
    name.value = clone ? appTitle.slice(0, 67) + " Copy" : "";
    if (create) {
      const cell = create.getBoundingClientRect();
      modal.style.setProperty("--birth-x", (cell.left + cell.width / 2 - innerWidth / 2) + "px");
      modal.style.setProperty("--birth-y", (cell.top + cell.height / 2 - innerHeight / 2) + "px");
    }
    modal.showModal();
    name.select();
  }
  create?.addEventListener("morka-divided", openSetup);
  clone?.addEventListener("click", openSetup);
  if (create) modal.addEventListener("close", () => {
    create.focus({ preventScroll: true });
    create.dispatchEvent(new Event("morka-reset"));
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (running || !name.value.trim()) return;
    running = true;
    submit.disabled = name.disabled = cancel.disabled = true;
    status.textContent = "Creating and installing project…";
    status.hidden = false;
    try {
      const result = await window.lab.installApp(name.value);
      if (!result) {
        status.hidden = true;
        return;
      }
      if ("error" in result) {
        status.textContent = result.error;
        return;
      }
      if (create) {
        if (result.openError) status.textContent = "Project created. Use “wake up a morka…” in Morka to open it. " + result.openError;
        else modal.close();
        return;
      }
      modal.close();
      if (!notice) return;
      notice.textContent = result.openError
        ? "Project created. Use “wake up a morka…” in Morka to open it. " + result.openError
        : "Your app is ready in the system application menu.";
      notice.title = result.path;
      notice.hidden = false;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      running = false;
      submit.disabled = name.disabled = cancel.disabled = false;
    }
  });
})();
