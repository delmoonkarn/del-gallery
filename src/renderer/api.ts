import type { Api } from "../main/preload";

declare global {
  interface Window {
    api: Api;
  }
}

export type FolderRow = {
  id: number;
  path: string;
  parent_id: number | null;
  name: string;
  depth: number;
  image_count: number;
  child_count: number;
  cover_path: string | null;
  tags: string[];
};

export type SortOpt = { by?: "name" | "mtime" | "image_count" | "random"; dir?: "asc" | "desc" };

export type RootInfo = {
  id: number;
  path: string;
  name: string;
  online: boolean;
  chapters: number;
  pages: number;
  lastScanned: number | null;
};

if (!window.api) {
  const msg =
    "window.api is undefined — Electron preload did not load. " +
    "Check the terminal running `npm run dev` for errors and verify dist-electron/preload/preload.mjs exists.";
  document.body.innerHTML =
    `<pre style="color:#fca5a5;background:#000;padding:24px;white-space:pre-wrap;font-family:ui-monospace,monospace;">${msg}</pre>`;
  throw new Error(msg);
}

export const api = window.api;

// Convert an absolute filesystem path to a local:// URL the renderer can <img src=>.
// We use a fake "f" host so the URL parser doesn't choke on Windows drive letters,
// then percent-encode the whole path into the URL's path component.
export function toLocalUrl(absPath: string): string {
  const normalized = absPath.replace(/\\/g, "/");
  // encodeURI leaves reserved characters like # and ? un-escaped, which
  // truncates the pathname when the URL is parsed (# starts a fragment,
  // ? starts a query string). Encode each path segment individually with
  // encodeURIComponent instead, so every character in folder/file names
  // is safely escaped while "/" still separates segments.
  const encoded = normalized.split("/").map(encodeURIComponent).join("/");
  return "local://f/" + encoded;
}
