import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const SNAPSHOT_MARKER = "<!-- visual-baselines:changed -->";
const SNAPSHOT_PATH_RE =
  /src\/assets\/visual-snapshots\/([^/]+\.test\.ts)\/([^`\n]+\.png)/g;

function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", ...options });
  if (res.error) {
    throw new Error(
      `Failed to run \`${cmd} ${args.join(" ")}\`: ${res.error.message}`
    );
  }
  if (res.signal) {
    throw new Error(
      `\`${cmd} ${args.join(" ")}\` was terminated by signal ${res.signal}`
    );
  }
  return res.status;
}

function silent(cmd, args) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function capture(cmd, args) {
  const res = silent(cmd, args);
  if (res.error || res.signal || res.status !== 0) {
    throw new Error(
      `\`${cmd} ${args.join(" ")}\` failed (exit ${
        res.status ?? res.signal ?? res.error?.message
      }).`
    );
  }
  return res.stdout.trim();
}

function specsInTmp(dir) {
  const specs = new Set();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of readdirSync(path.join(dir, entry.name))) {
      if (file.endsWith(".png")) specs.add(`ui-tests/${entry.name}`);
    }
  }
  return [...specs].sort();
}

let madeStash = false;
let restored = false;
let tmpDir = null;
let originalBranch = null;
let originalSha = null;
let viewerPid = null;

function restore() {
  if (restored) return;
  restored = true;

  if (originalSha) {
    const targets = originalBranch
      ? [originalBranch, originalSha]
      : [originalSha];
    for (const target of targets) {
      const res = spawnSync(
        "git",
        ["checkout", ...(target === originalSha ? ["--detach"] : []), target],
        { stdio: "inherit" }
      );
      if (res.status === 0) break;
    }
  }

  if (madeStash) {
    let res = spawnSync("git", ["stash", "pop", "--index"], {
      stdio: "inherit",
    });
    if (res.status !== 0) {
      res = spawnSync("git", ["stash", "pop"], { stdio: "inherit" });
    }
    if (res.status !== 0) {
      console.warn(
        "\n[compare] Could not restore your stashed changes automatically - run `git stash pop` to recover them."
      );
    }
  }

  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  if (viewerPid) {
    try {
      process.kill(viewerPid, "SIGTERM");
    } catch (err) {}
    viewerPid = null;
  }
}

process.on("SIGINT", () => {
  restore();
  process.exit(130);
});
process.on("SIGTERM", () => {
  restore();
  process.exit(143);
});

function walkSpecs(suites, visit) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) visit(spec);
    walkSpecs(suite.suites ?? [], visit);
  }
}

function parseFailures(report) {
  const changed = new Map();
  const otherFailures = [];

  walkSpecs(report?.suites, (spec) => {
    for (const test of spec.tests ?? []) {
      const results = test.results ?? [];
      const finalResult = results[results.length - 1];
      if (!finalResult) continue;
      if (
        finalResult.status !== "failed" &&
        finalResult.status !== "timedOut"
      ) {
        continue;
      }

      const names = new Set();
      for (const attachment of finalResult.attachments ?? []) {
        const match = attachment.name?.match(
          /^(.+)-(?:actual|expected|diff)\.png$/
        );
        if (match) names.add(`${match[1]}.png`);
      }

      if (names.size > 0) {
        for (const name of names) {
          changed.set(name, {
            title: spec.title,
            specFile: spec.file,
            actualPath: (finalResult.attachments ?? []).find(
              (a) => a.name === name.replace(/\.png$/, "-actual.png")
            )?.path,
          });
        }
      } else {
        otherFailures.push(spec.title);
      }
    }
  });

  return { changed, otherFailures };
}

function waitForEnter(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

try {
  console.log("=== npm run compare ===\n");

  console.log("[1/9] Checking that `gh` is installed and authenticated");
  const authStatus = run("gh", ["auth", "status"]);
  if (authStatus !== 0) {
    throw new Error(
      `\`gh\` is either not installed or not authenticated (exit ${authStatus}).`
    );
  }

  console.log("\n[2/9] Finding the open pull request for the current branch");
  const repo = capture("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]);
  const prRes = silent("gh", [
    "pr",
    "view",
    "--json",
    "number,baseRefName,headRefName",
  ]);
  if (prRes.status !== 0) {
    const branch =
      silent("git", ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim() ||
      "current branch";
    throw new Error(
      `No open pull request found for ${branch}.\nPush the branch and open a PR first - compare replays the screenshot diffs CI flagged on that PR.\n(stderr: ${(prRes.stderr ?? "").trim()})`
    );
  }
  const pr = JSON.parse(prRes.stdout);
  pr.baseOid = capture("gh", [
    "api",
    `repos/${repo}/pulls/${pr.number}`,
    "--jq",
    ".base.sha",
  ]);

  const commentsRes = silent("gh", [
    "api",
    `repos/${repo}/issues/${pr.number}/comments`,
    "--paginate",
  ]);
  if (commentsRes.status !== 0) {
    throw new Error(
      `Failed to read comments on PR #${pr.number}: ${(
        commentsRes.stderr ?? ""
      ).trim()}`
    );
  }
  const markerBodies = (JSON.parse(commentsRes.stdout.trim() || "[]") ?? [])
    .map((comment) => comment.body ?? "")
    .filter((body) => body.includes(SNAPSHOT_MARKER));
  const markerBody = markerBodies[markerBodies.length - 1];

  if (!markerBody) {
    console.warn(
      `\n[compare] PR #${pr.number} has no \`${SNAPSHOT_MARKER}\` comment yet. \nCI flags a comparison only once baselines differ - if CI hasn't run (or no baselines changed), there is nothing to compare.\n`
    );
    process.exit(0);
  }

  const changed = [];
  for (const match of markerBody.matchAll(SNAPSHOT_PATH_RE)) {
    changed.push({ testFile: match[1], png: match[2] });
  }
  if (changed.length === 0) {
    throw new Error(
      `PR #${pr.number} has a \`${SNAPSHOT_MARKER}\` comment, but no src/assets/visual-snapshots/...png entries could be parsed from it.`
    );
  }
  console.log(
    `PR #${pr.number} (\`${pr.headRefName}\` -> \`${pr.baseRefName}\`) flags ${changed.length} changed snapshot(s).`
  );

  console.log(
    "\n[3/9] Stashing uncommitted changes (tracking staged vs unstaged)"
  );
  originalBranch =
    silent("git", [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]).stdout.trim() || null;
  originalSha = capture("git", ["rev-parse", "HEAD"]);
  const stashRefBefore = spawnSync(
    "git",
    ["rev-parse", "-q", "--verify", "refs/stash"],
    { stdio: ["ignore", "pipe", "pipe"] }
  )
    .stdout.toString()
    .trim();
  const stashStatus = run("git", [
    "stash",
    "push",
    "-u",
    "-m",
    `compare: ${pr.headRefName}`,
  ]);
  if (stashStatus !== 0) {
    throw new Error(
      `Failed to stash uncommitted changes (exit ${stashStatus}). Nothing was changed.`
    );
  }
  const stashRefAfter = spawnSync(
    "git",
    ["rev-parse", "-q", "--verify", "refs/stash"],
    { stdio: ["ignore", "pipe", "pipe"] }
  )
    .stdout.toString()
    .trim();
  madeStash = !(stashRefAfter == "" || stashRefAfter == stashRefBefore);
  if (!madeStash) {
    console.log("  (working tree was clean - nothing to stash)");
  }

  console.log(
    "\n[4/9] Checking out the PR target branch as the snapshot source"
  );
  let baseOid = pr.baseOid;
  const fetchRes = silent("git", ["fetch", "origin", baseOid, "--no-tags"]);
  if (fetchRes.status !== 0) {
    run("git", ["fetch", "origin", pr.baseRefName, "--no-tags"]);
    baseOid = `origin/${pr.baseRefName}`;
    console.warn(
      `\n[compare] Could not fetch base commit \`${pr.baseOid}\` - compared against the latest \`origin/${pr.baseRefName}\` instead.`
    );
  }
  const baseStatus = run("git", ["checkout", "--detach", baseOid]);
  if (baseStatus !== 0) {
    throw new Error(
      `Failed to check out base \`${baseOid}\` (exit ${baseStatus}).`
    );
  }

  console.log(
    "\n[5/9] Generating local snapshot baselines from the base branch"
  );
  if (existsSync(".local-snapshots")) {
    rmSync(".local-snapshots", { recursive: true, force: true });
  }
  const genStatus = run("npm", ["run", "generate:screenshots"]);
  if (genStatus !== 0) {
    throw new Error(
      `Snapshot generation failed (exit ${genStatus}). Run \`npm run generate\` on the base branch to inspect.`
    );
  }

  console.log(
    "\n[6/9] Copying the PR-flagged changed snapshots into a temp dir"
  );
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "compare-visual-"));
  let copied = 0;
  for (const { testFile, png } of changed) {
    const src = path.join(".local-snapshots", testFile, png);
    if (!existsSync(src)) {
      console.warn(
        `\n[compare] missing baseline ${testFile}/${png} - skipping`
      );
      continue;
    }
    const dest = path.join(tmpDir, testFile, png);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    copied += 1;
  }
  console.log(`  copied ${copied}/${changed.length} baseline(s) to ${tmpDir}`);

  console.log("\n[7/9] Checking out the PR head again");
  const headStatus = originalBranch
    ? run("git", ["checkout", originalBranch])
    : run("git", ["checkout", "--detach", originalSha]);
  if (headStatus !== 0) {
    throw new Error(
      `Failed to check out the PR head again (exit ${headStatus}).`
    );
  }

  const specs = specsInTmp(tmpDir);
  if (specs.length === 0) {
    throw new Error(
      "No test specs could be derived from the flagged snapshots - nothing to run."
    );
  }

  console.log(
    `\n[8/9] Reviewing diffs round by round against the current code (${specs.length} spec(s)):\n  ${specs.join("\n  ")}`
  );

  const seen = new Map();
  let round = 0;
  let acceptedAny = false;

  while (true) {
    round += 1;
    console.log(
      `\n  round ${round}: running playwright for:\n    ${specs
        .map((spec) => `  - ${spec}`)
        .join("\n")}`
    );

    const res = spawnSync(
      "npx",
      ["playwright", "test", ...specs, "--reporter=html,json"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          LOCAL_SNAPSHOTS: "1",
          PLAYWRIGHT_HTML_OPEN: "never",
        },
      }
    );
    if (res.error || res.signal) {
      throw new Error(
        `Playwright round ${round} failed to start: ${
          res.signal ?? res.error.message
        }`
      );
    }

    let report;
    try {
      report = JSON.parse(res.stdout.trim());
    } catch {
      throw new Error(
        `Failed to parse playwright's JSON report (round ${round}).\n` +
          (res.stdout
            ? `Raw output:\n${res.stdout.slice(0, 2000)}`
            : "(no test output - check that the playwright dev server is not already in use)")
      );
    }

    const { changed, otherFailures } = parseFailures(report);
    if (otherFailures.length > 0) {
      throw new Error(
        `Round ${round} failed for non-screenshot reasons and can't be auto-accepted:\n  - ${otherFailures.join(
          "\n  - "
        )}`
      );
    }

    if (changed.size === 0) {
      if (res.status === 0) break;
      throw new Error(
        `Round ${round} failed (exit ${res.status}) but produced no screenshot diffs to accept.`
      );
    }

    const names = [...changed.keys()].sort();
    console.log(
      `  round ${round} shows ${changed.size} diff(s):\n    ${names.join(
        "\n    "
      )}`
    );

    if (!viewerPid) {
      console.log(
        "\n[9/9] Starting the playwright report server (stays open across rounds)."
      );
      const viewer = spawn(
        "npx",
        ["playwright", "show-report", "playwright-report"],
        {
          detached: true,
          stdio: "inherit",
        }
      );
      viewerPid = viewer.pid;
      viewer.unref();
      console.log(
        "\n  Open the report at http://localhost:9323 and compare with the diff/slider/side-by-side views."
      );
    }

    await waitForEnter(
      "\n  Review the diffs, then press Enter to accept them as baselines and run the next round: "
    );

    for (const name of names) {
      const { specFile, actualPath } = changed.get(name);
      const testFile = path.basename(specFile);
      if (!actualPath) {
        console.warn(
          `\n[compare] ${testFile}/${name}: no "actual" image recorded - nothing to accept for it.`
        );
        continue;
      }
      copyFileSync(actualPath, path.join(".local-snapshots", testFile, name));
      seen.set(`${testFile}/${name}`, true);
      acceptedAny = true;
      console.log(`  accepted ${testFile}/${name}`);
    }
  }

  const baselineNote = acceptedAny
    ? `\n[9/9] All flagged comparisons are clean after ${round} round(s). ${seen.size} accepted baseline(s):\n    ${[
        ...seen.keys(),
      ]
        .sort()
        .join("\n    ")}`
    : `\n[9/9] All flagged comparisons are already clean against the current\nlocal baselines (${round} round(s), nothing to accept).`;

  console.log(baselineNote);

  restore();
  process.exit(0);
} catch (err) {
  console.error(`\n[compare] ${err.message}`);
  restore();
  process.exit(1);
}
