const updatePanel = document.querySelector<HTMLElement>("#launcher-update")!;
const updateStatus = document.querySelector<HTMLElement>("#launcher-update-status")!;
const updateButton = document.querySelector<HTMLButtonElement>("#launcher-update-action")!;
let state: DesktopUpdateState | undefined;

function renderUpdate(next?: DesktopUpdateState) {
  state = next;
  updatePanel.hidden = !next;
  if (!next) return;
  updateButton.disabled = ["checking", "downloading", "installing"].includes(next.status);
  let actionLabel = "Check for updates";
  switch (next.status) {
    case "idle": updateStatus.textContent = ""; break;
    case "checking": updateStatus.textContent = "Checking for updates…"; break;
    case "current": updateStatus.textContent = "Morka is up to date."; break;
    case "available":
      actionLabel = next.detail ? "Retry download" : "Download update";
      updateStatus.textContent = next.detail ? `Could not download Morka ${next.version}. ${next.detail}`
        : `Morka ${next.version} is available.`;
      break;
    case "downloading":
      actionLabel = "Download update";
      updateStatus.textContent = next.percent === undefined ? `Downloading ${next.version}…`
        : `Downloading ${next.version} (${next.percent}%)…`;
      break;
    case "ready":
      actionLabel = next.action === "open" ? "Open installer" : next.action === "show" ? "Show download" : "Restart to update";
      updateStatus.textContent = next.detail ?? (next.action === "show" ? `Morka ${next.version} has been downloaded. Extract it to install the update.`
        : `Morka ${next.version} is ready to install.`);
      break;
    case "installing":
      actionLabel = next.action === "open" ? "Open installer" : next.action === "show" ? "Show download" : "Restart to update";
      updateStatus.textContent = `Preparing to install ${next.version}…`;
      break;
    case "error": updateStatus.textContent = next.detail; break;
  }
  updateButton.textContent = actionLabel;
}

let receivedUpdate = false;
window.lab.onDesktopUpdate(next => {
  receivedUpdate = true;
  renderUpdate(next);
});
void window.lab.desktopUpdateState().then(next => { if (!receivedUpdate) renderUpdate(next); }).catch(console.error);
updateButton.addEventListener("click", () => {
  let action: Promise<void>;
  if (state?.status === "available") action = window.lab.downloadDesktopUpdate();
  else if (state?.status === "ready") action = window.lab.installDesktopUpdate();
  else action = window.lab.checkDesktopUpdate();
  void action.catch(error => { updateStatus.textContent = error instanceof Error ? error.message : String(error); });
});
