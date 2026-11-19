import { execFileSync } from "node:child_process";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trimEnd();
}

const [base = "main", head = "HEAD", branch = git("branch", "--show-current")] = process.argv.slice(2);
const types = "(?:feat|fix|docs|test|refactor|perf|build|ci|chore|revert)";
const segment = "[a-z][a-z0-9]*(?:-[a-z0-9]+)*";
const branchName = new RegExp("^" + types + "/(?:[0-9]+-)?" + segment + "$");
const subject = new RegExp("^" + types + "(?:\\(" + segment + "\\))?!?: \\S.*$");

if (!branchName.test(branch)) {
  console.error("Invalid topic branch '" + branch + "'. Expected <type>/<kebab-case-description>.");
  process.exitCode = 1;
}

const resolve = (ref) => git("rev-parse", "--verify", "--end-of-options", ref + "^{commit}");
const commits = git("log", "--format=%h%x09%s", resolve(base) + ".." + resolve(head), "--");
for (const line of commits.split("\n").filter(Boolean)) {
  const title = line.slice(line.indexOf("\t") + 1);
  if (!subject.test(title)) {
    console.error("Invalid commit subject: " + line);
    process.exitCode = 1;
  }
}
