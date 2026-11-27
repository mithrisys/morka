<p align="center">
  <img src="host/branding/morka-icon.png" width="96" height="96" alt="">
</p>
<h1 align="center">Morka</h1>
<p align="center"><strong>Build your own AI-powered desktop app with Morka and your existing coding agent subscription.</strong><br>
Edit your app as you use it and see changes live without losing state.</p>
<p align="center">
  <a href="https://github.com/mithrisys/morka/releases"><strong>Download Morka</strong></a>
  · <a href="#quickstart">Build your first app</a>
  · <a href="#run-morka-from-source">Run from source</a>
</p>

Use your existing Codex or Claude Code subscription to build your app for macOS, Windows, or Linux and power its AI features. No separate API key required.

## Quickstart

1. **Install Morka.** Choose the release asset for your operating system and architecture. Morka includes Node.js and npm. For this walkthrough, have the Codex or Claude Code CLI installed and signed in on your computer. [Downloads and release notes](https://github.com/mithrisys/morka/releases)
2. **Create your app.** Open Morka and swipe right on the launcher, or focus the create button and press Enter. Name the app *Meeting Scratchpad* and choose a folder. In the app window, click the brain icon to check your sign-in under **AI setup**.
3. **Give it a job.** Open **Chat**, pick your agent, and paste this prompt.

   > Build me a meeting scratchpad that saves my notes locally. Add a “Find action items” button that uses my AI agent to turn the current note into a checklist. Keep the original note so I can check what the agent picked up.

4. **Try the button.** Once the app updates, type “I’ll send Maya the mockups on Friday. We also talked about the new logo.” Click **Find action items** and approve access to your local agent account when Morka asks. Look for the promise to send the mockups in the checklist.
5. **Make a change with the note still open.** Ask “Put the checklist beside my note so I can read both at once.” Watch the layout update in the same window. To try another agent, pick it beside the message field and send your next request in the same chat.

### Desktop downloads

| Platform | Architecture | What to install |
| --- | --- | --- |
| macOS | Apple Silicon | Open the DMG, drag Morka into Applications, then open it from there. This build uses an ad-hoc signature and lacks Apple notarization. If macOS says it cannot verify Morka, dismiss the alert and go to **System Settings → Privacy & Security**. Click **Open Anyway** for Morka, then **Open** to confirm. [Apple’s guide](https://support.apple.com/en-us/102445) |
| Windows | x64 or ARM64 | Run the setup executable for your architecture. |
| Linux | x64 or ARM64 | On Debian or Ubuntu, run `sudo apt install ./morka-*.deb` from your download folder. On Fedora, use `sudo dnf install ./morka-*.rpm`. |

Linux also has a portable tarball. On Ubuntu 24.04 and newer, use the `.deb` to install the AppArmor profile for Electron. Each release includes checksums and platform signing notes. [GitHub Releases](https://github.com/mithrisys/morka/releases)

## How your app grows

**Keep your place through edits.** Morka restores the current page, form input, focus, and scroll position after a code update. Apps can also preserve their own state, such as a selected tab or filter. If an edit fails its build or preview check, the last working version stays open and the agent keeps its draft for repair. [Live updates and app state](docs/app-authoring.md#run-and-update-the-app)

**Choose an agent for each turn.** Ask Codex to build a feature, then ask Claude Code to refine it. Both work on the same draft, and their replies stay in one conversation. On macOS, project chat also supports ACP agents such as Hermes and Pi. [Agent setup and sessions](docs/app-authoring.md#agents-and-chat-sessions)

**Bring AI into any part of your app.** A notebook can suggest tags as you write, or a planner can turn a project brief into a checklist as you import it. An *agent action* lets your app send the relevant text to Codex or Claude Code and use the structured result in its workflow. You choose which apps can use your account, and Morka keeps your credentials outside the app. [Build an agent action](host/skills/morka-agent-action/SKILL.md)

## Reuse skills across apps with Shadows

A Shadow bundles agent skills, rules, and optional assets you can reuse across projects. For example, pack your design rules, icons, and example styles into a Shadow so your agent can follow the same design in your next app. Open **Shadows** in the toolbar and choose **New Shadow** to create one or **Install Shadow** to use one in the current app. [Shadow guide](docs/app-authoring.md#plugin-shadow)

## Clone it, share it, make it yours

Click **Clone** in an open app to start a new version in its own Git repository. You could keep your meeting scratchpad and turn the copy into an interview notebook. Apps created in the installed desktop version get lightweight launchers that share Morka’s Electron and Node.js runtime. Each app keeps its own dependencies and appears under its own name in your system’s application menu or Applications folder.

To share an app, send its Git URL or a ZIP or TAR.GZ archive of the project. The recipient opens Morka, chooses **or wake up a morka…**, and pastes the URL or picks the archive. Git URL imports require Git. Notes stored in Morka’s private data directory, chat history, and account permissions stay on your machine. The recipient connects their own account for AI features.

On macOS, you can also run `npm run package:mac` from the app repository to export a self-contained `.app` that opens offline on a Mac without Morka installed. [Packaging and runtime compatibility](docs/app-authoring.md#choose-a-desktop-runtime)

## Run Morka from source

To build and launch the desktop host, use Node.js 24 or newer and npm.

```sh
git clone https://github.com/mithrisys/morka.git
cd morka
npm ci
npm start
```

The [app authoring guide](docs/app-authoring.md) covers project structure and reusable skills. Type `/review` in app chat to exercise the main workflow at two window sizes. [Workflow review](docs/preview-scenarios.md)

## How to contribute

- **Report a bug or suggest a feature.** For a bug, include your OS, Morka version, and the shortest steps that reproduce it. For a feature, describe what you were trying to do. [Open an issue](https://github.com/mithrisys/morka/issues/new)
- **Send a fix or improve the docs.** Start a branch from `main`, keep the change focused, and open a pull request describing what changed and how you checked it. The [contributing guide](CONTRIBUTING.md) covers branch names, tests, and commits. The [architecture overview](docs/architecture.md) shows where the pieces fit.

[Changelog](CHANGELOG.md) · [MIT License](LICENSE)

Bundled third-party components retain their own licenses.
