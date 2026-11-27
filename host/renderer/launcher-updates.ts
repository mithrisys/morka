const updatePanel = document.querySelector<HTMLElement>("#launcher-update")!;
const updateStatus = document.querySelector<HTMLElement>("#launcher-update-status")!;
const updateButton = document.querySelector<HTMLButtonElement>("#launcher-update-action")!;
let state: MacUpdateState | undefined;

function renderUpdate(next?: MacUpdateState) {
  state = next;
  updatePanel.hidden = !next;
  if (!next) return;
  updateButton.disabled = ["checking", "downloading", "installing"].includes(next.status);
  updateButton.textContent = next.status === "ready" || next.status === "installing" ? "Restart to update" : "Check for updates";
  switch (next.status) {
    case "idle": updateStatus.textContent = ""; break;
    case "checking": updateStatus.textContent = "Checking for updates…"; break;
    case "current": updateStatus.textContent = "Morka is up to date."; break;
    case "downloading": updateStatus.textContent = next.percent === undefined ? `Downloading ${next.version}…`
      : `Downloading ${next.version} (${next.percent}%)…`; break;
    case "ready": updateStatus.textContent = next.detail ?? `Morka ${next.version} is ready to install.`; break;
    case "installing": updateStatus.textContent = `Preparing to install ${next.version}…`; break;
    case "error": updateStatus.textContent = next.detail; break;
  }
}

let receivedUpdate = false;
window.lab.onMacUpdate(next => {
  receivedUpdate = true;
  renderUpdate(next);
});
void window.lab.macUpdateState().then(next => { if (!receivedUpdate) renderUpdate(next); }).catch(console.error);
updateButton.addEventListener("click", () => {
  const action = state?.status === "ready" ? window.lab.restartForMacUpdate() : window.lab.checkMacUpdate();
  void action.catch(error => { updateStatus.textContent = error instanceof Error ? error.message : String(error); });
});
