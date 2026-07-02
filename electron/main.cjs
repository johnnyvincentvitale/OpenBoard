const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");

const REPO = path.resolve(__dirname, "..");
const BOARD_PORT = process.env.BOARD_PORT || "4097";
const OPENCODE_PORT = process.env.OPENCODE_PORT || "4096";
// Where dispatched agents do their work (opencode's cwd). User-overridable.
const WORKSPACE = process.env.BOARD_WORKSPACE || app.getPath("home");

let adapter = null;

function startAdapter() {
  // Dev: run the TypeScript source via tsx. Packaged: run the esbuild-bundled
  // server (dist/server/serve.cjs) with the Electron binary in Node mode —
  // tsx is a devDependency and isn't shipped in the packaged app.
  const env = {
    ...process.env,
    BOARD_PORT,
    OPENCODE_PORT,
    BOARD_WEB_DIR: path.join(REPO, "dist", "web"),
    BOARD_DB_PATH: path.join(app.getPath("userData"), "board.sqlite"),
    BOARD_TASK_DB_PATH: path.join(app.getPath("userData"), "board-tasks.sqlite"),
  };

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
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "opencode-board",
    backgroundColor: "#0b0d10",
  });
  win.loadURL(`http://127.0.0.1:${BOARD_PORT}`);
  // Open external links in the system browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  startAdapter();
  waitForHealth((err) => {
    if (err) console.error(err);
    createWindow();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
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
