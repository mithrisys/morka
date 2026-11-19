import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { agentLaunch, type LocalProvider } from "./process";

const providers = {
  codex: { install: "npm install -g @openai/codex", login: "codex login", status: ["login", "status"] },
  claude: { install: "npm install -g @anthropic-ai/claude-code", login: "claude auth login", status: ["auth", "status", "--json"] },
};

export async function localAccount(provider: LocalProvider): Promise<AgentAccountStatus> {
  const { install, login, status } = providers[provider];
  try {
    const cli = await agentLaunch(provider, status);
    return await new Promise<AgentAccountStatus>(resolve => {
      execFile(cli.command, cli.args, { cwd: homedir(), env: cli.env, timeout: 8000, maxBuffer: 64 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          let state: AgentAccountStatus["state"] = "unavailable";
          if (provider === "codex") {
            const message = stdout + "\n" + stderr;
            if (!error && /\blogged in\b/i.test(message)) state = "ready";
            else if (/\bnot logged in\b/i.test(message)) state = "signed-out";
          } else {
            try {
              const { loggedIn } = JSON.parse(stdout);
              if (loggedIn === true && !error) state = "ready";
              else if (loggedIn === false) state = "signed-out";
            } catch { /* Keep the status unavailable when the CLI does not return valid JSON. */ }
          }
          resolve({ state, install, login });
        });
    });
  } catch {
    return { state: "missing", install, login };
  }
}
