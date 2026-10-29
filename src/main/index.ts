import { app, BrowserWindow, protocol } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { registerIpc } from "./ipc";
import { getDb } from "./db";
import { isEntryPath, readArchiveEntry, splitEntryPath } from "./archive";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !!process.env.VITE_DEV_SERVER_URL;

// Keep ALL Electron-managed data (Chromium cache, cookies, localStorage,
// IndexedDB, GPUCache, logs, etc.) inside the app folder instead of %APPDATA%.
// Must be set before app.whenReady().
{
  const appRoot = app.isPackaged ? path.dirname(app.getPath("exe")) : app.getAppPath();
  app.setPath("userData", path.join(appRoot, "userdata"));
  // Some Chromium subsystems use cache / sessionData / logs paths independently.
  app.setPath("sessionData", path.join(appRoot, "userdata"));
  app.setPath("logs", path.join(appRoot, "userdata", "logs"));
}

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
};

// Register custom scheme as privileged BEFORE app is ready so the renderer can fetch it.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "local",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false },
  },
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#0a0a0a",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL!);
    // Open DevTools manually with Ctrl+Shift+I or F12 when needed.
  } else {
    win.loadFile(path.join(__dirname, "../../dist/index.html"));
  }
}

app.whenReady().then(() => {
  // local://f/<urlencoded-absolute-path> -> file on disk
  protocol.handle("local", async (req) => {
    try {
      const u = new URL(req.url);
      const raw = decodeURIComponent(u.pathname).replace(/^\/+/, "");
      // "<archive>|<entry>" = a page inside a .cbz/.zip (see archive.ts).
      if (isEntryPath(raw)) {
        const { archive, entry } = splitEntryPath(raw);
        const data = await readArchiveEntry(path.normalize(archive), entry);
        const mime = MIME[path.extname(entry).toLowerCase()] ?? "application/octet-stream";
        return new Response(new Uint8Array(data), { headers: { "Content-Type": mime } });
      }
      const filePath = path.normalize(raw);
      const data = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = MIME[ext] ?? "application/octet-stream";
      return new Response(data, { headers: { "Content-Type": mime } });
    } catch (err) {
      return new Response(`local:// fetch failed: ${(err as Error).message}`, { status: 404 });
    }
  });

  getDb();
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
