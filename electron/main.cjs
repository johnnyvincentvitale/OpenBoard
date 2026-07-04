const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");
const {
  resolveBoardPort,
  resolveOpencodePort,
  isDefaultPort,
  windowTitle,
  resolveUserDataPath,
  buildAdapterEnv,
} = require("./instance.cjs");

const REPO = path.resolve(__dirname, "..");

// Multi-instance support: OPENBOARD_PORT (adapter port) and
// OPENBOARD_OPENCODE_PORT (the spawned OpenCode server's port) are the
// canonical env vars — BOARD_PORT / OPENCODE_PORT are kept as legacy
// fallbacks so existing single-instance setups are unaffected. Two Electron
// apps launched with different OPENBOARD_PORT values are fully independent:
// disjoint adapter ports, disjoint (port-scoped, unless OPENBOARD_DB is set)
// DB files, and disjoint spawned OpenCode backends. See instance.cjs for the
// (unit-tested) resolution logic, and the README's "Running multiple
// instances" section for a worked example.
const BOARD_PORT = resolveBoardPort(process.env);
const OPENCODE_PORT = resolveOpencodePort(process.env);
// Where dispatched agents do their work (opencode's cwd). User-overridable.
const WORKSPACE = process.env.BOARD_WORKSPACE || app.getPath("home");

// Electron/Chromium's own single-instance behavior (the "SingletonLock" file
// and, if an app opts in, requestSingleInstanceLock()) is keyed off the
// `userData` directory, not per-instance state — so it can only be "scoped
// per port" by giving each non-default-port instance its own userData
// directory. This must run before `app.whenReady()` (setPath has no effect
// after that). The default-port instance keeps the original directory, so
// single-instance behavior and DB file locations are unchanged for the
// common case.
if (!isDefaultPort(BOARD_PORT)) {
  app.setPath("userData", resolveUserDataPath(app.getPath("userData"), BOARD_PORT));
}

// Standard single-instance lock — now correctly scoped per port because it's
// keyed off the (possibly port-suffixed) userData directory set above. Two
// launches with the SAME port collapse to one (second exits, focuses the
// first); two launches with DIFFERENT ports each get their own lock and
// coexist normally.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let adapter = null;
let mainWindow = null;

function startAdapter() {
  // Dev: run the TypeScript source via tsx. Packaged: run the esbuild-bundled
  // server (dist/server/serve.cjs) with the Electron binary in Node mode —
  // tsx is a devDependency and isn't shipped in the packaged app.
  const env = buildAdapterEnv({
    env: process.env,
    boardPort: BOARD_PORT,
    opencodePort: OPENCODE_PORT,
    userDataPath: app.getPath("userData"),
    webDir: path.join(REPO, "dist", "web"),
  });

  if (app.isPackaged) {
    adapter = spawn(process.execPath, [path.join(REPO, "dist", "server", "serve.mjs")], {
      cwd: WORKSPACE,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "inherit",
    });
  } else {
    const tsx = path.join(REPO, "node_modules", ".bin", "tsx");
    adapter = spawn(tsx, [path.join(REPO, "src", "server", "serve.ts")], {
      cwd: WORKSPACE,
      env,
      stdio: "inherit",
    });
  }

  adapter.on("exit", (code) => {
    // eslint-disable-next-line no-console
    console.log(`adapter exited (${code})`);
  });
}

function waitForHealth(done, attempts = 80) {
  const ping = (n) => {
    const req = http.get(`http://127.0.0.1:${BOARD_PORT}/api/health`, (res) => {
      res.resume();
      done();
    });
    req.on("error", () => {
      if (n <= 0) return done(new Error("adapter did not come up"));
      setTimeout(() => ping(n - 1), 500);
    });
  };
  ping(attempts);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: windowTitle(BOARD_PORT),
    backgroundColor: "#0b0d10",
  });
  mainWindow.loadURL(`http://127.0.0.1:${BOARD_PORT}`);
  // Open external links in the system browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  if (!gotLock) return;
  startAdapter();
  waitForHealth((err) => {
    if (err) console.error(err);
    createWindow();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("second-instance", () => {
  // Another launch at this same port — focus the existing window instead of
  // starting a second, port-colliding adapter.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function stopAdapter() {
  if (adapter && !adapter.killed) adapter.kill();
  adapter = null;
}

app.on("window-all-closed", () => {
  stopAdapter();
  app.quit();
});
app.on("quit", stopAdapter);
