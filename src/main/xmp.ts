import fs from "node:fs/promises";
import path from "node:path";

const XMP_MARKER = Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1");

/** What we keep in a cover's XMP: tags (dc:subject), stars (xmp:Rating) and favourite (xmp:Label). */
export type XmpMeta = { tags: string[]; rating: number; favorite: boolean };

const EMPTY: XmpMeta = { tags: [], rating: 0, favorite: false };
const FAVORITE_LABEL = "Favorite";

export function isJpegPath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".jpg" || ext === ".jpeg";
}

function parsePacket(packet: Buffer): XmpMeta {
  const xml = packet.toString("utf8");
  return { tags: parseDcSubject(packet), rating: parseRating(xml), favorite: parseLabel(xml) === FAVORITE_LABEL };
}

/** `found` is false when the file has no XMP packet at all (or isn't really a JPEG). */
export async function readXmp(filePath: string): Promise<XmpMeta & { found: boolean }> {
  if (!isJpegPath(filePath)) return { ...EMPTY, found: false };
  try {
    const packet = extractJpegXmpPacket(await fs.readFile(filePath));
    return packet ? { ...parsePacket(packet), found: true } : { ...EMPTY, found: false };
  } catch {
    return { ...EMPTY, found: false };
  }
}

/** Rewrite the cover's XMP with `patch` applied; fields not in the patch keep their current value. */
export async function updateXmp(filePath: string, patch: Partial<XmpMeta>): Promise<XmpMeta> {
  if (!isJpegPath(filePath)) {
    throw new Error(`XMP write only supported for JPEG; got ${path.extname(filePath).toLowerCase()}`);
  }
  const buf = await fs.readFile(filePath);
  const packet = extractJpegXmpPacket(buf);
  const next: XmpMeta = { ...(packet ? parsePacket(packet) : EMPTY), ...patch };
  const out = replaceXmpPacket(buf, buildXmpPacket(next));
  // Clear read-only attribute (Windows) so we can write back in place.
  try {
    await fs.chmod(filePath, 0o666);
  } catch {
    /* ignore — chmod may not be supported on every FS */
  }
  await fs.writeFile(filePath, out);
  return next;
}

// xmp:Rating as an attribute or element; MicrosoftPhoto:Rating (1–99 %) as a fallback.
function parseRating(xml: string): number {
  const m = /xmp:Rating(?:\s*=\s*["'](-?\d+)["']|>\s*(-?\d+)\s*<)/.exec(xml);
  if (m) return Math.min(5, Math.max(0, parseInt(m[1] ?? m[2], 10) || 0));
  const p = /MicrosoftPhoto:Rating(?:\s*=\s*["'](\d+)["']|>\s*(\d+)\s*<)/.exec(xml);
  if (p) {
    const pct = parseInt(p[1] ?? p[2], 10) || 0;
    return pct >= 99 ? 5 : pct >= 75 ? 4 : pct >= 50 ? 3 : pct >= 25 ? 2 : pct >= 1 ? 1 : 0;
  }
  return 0;
}

function parseLabel(xml: string): string {
  const m = /xmp:Label(?:\s*=\s*["']([^"']*)["']|>([^<]*)<)/.exec(xml);
  return decodeEntities((m?.[1] ?? m?.[2] ?? "").trim());
}

// Windows Explorer shows stars from MicrosoftPhoto:Rating (percent) as well as xmp:Rating.
const MS_PERCENT = [0, 1, 25, 50, 75, 99];

function extractJpegXmpPacket(buf: Buffer): Buffer | null {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xda || marker === 0xd9) return null; // SOS / EOI
    const segLen = buf.readUInt16BE(i + 2);
    const segStart = i + 4;
    const segEnd = segStart + segLen - 2;
    if (marker === 0xe1 && segEnd <= buf.length) {
      const seg = buf.subarray(segStart, segEnd);
      if (seg.subarray(0, XMP_MARKER.length).equals(XMP_MARKER)) {
        return seg.subarray(XMP_MARKER.length);
      }
    }
    i = segStart + segLen - 2;
  }
  return null;
}

function parseDcSubject(packet: Buffer): string[] {
  const xml = packet.toString("utf8");
  const subjectMatch = xml.match(/<(?:\w+:)?subject\b[^>]*>([\s\S]*?)<\/(?:\w+:)?subject>/i);
  if (!subjectMatch) return [];
  const inner = subjectMatch[1];
  const tags: string[] = [];
  const liRe = /<(?:\w+:)?li\b[^>]*>([\s\S]*?)<\/(?:\w+:)?li>/gi;
  let m: RegExpExecArray | null;
  while ((m = liRe.exec(inner))) {
    const t = decodeEntities(m[1]).trim();
    if (t) tags.push(t);
  }
  return tags;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function encodeEntities(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildXmpPacket(meta: XmpMeta): Buffer {
  const rating = Math.min(5, Math.max(0, Math.round(meta.rating)));
  const extra =
    (rating > 0
      ? `   <xmp:Rating>${rating}</xmp:Rating>\n   <MicrosoftPhoto:Rating>${MS_PERCENT[rating]}</MicrosoftPhoto:Rating>\n`
      : "") + (meta.favorite ? `   <xmp:Label>${FAVORITE_LABEL}</xmp:Label>\n` : "");
  const li = meta.tags.map((t) => `      <rdf:li>${encodeEntities(t)}</rdf:li>`).join("\n");
  const xml =
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="gallery">\n` +
    ` <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n` +
    `  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"` +
    ` xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:MicrosoftPhoto="http://ns.microsoft.com/photo/1.0/">\n` +
    extra +
    `   <dc:subject>\n` +
    `    <rdf:Bag>\n${li}\n    </rdf:Bag>\n` +
    `   </dc:subject>\n` +
    `  </rdf:Description>\n` +
    ` </rdf:RDF>\n` +
    `</x:xmpmeta>\n` +
    `<?xpacket end="w"?>`;
  return Buffer.from(xml, "utf8");
}

function replaceXmpPacket(buf: Buffer, newPacket: Buffer): Buffer {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error("not a JPEG");

  const parts: Buffer[] = [buf.subarray(0, 2)];
  let i = 2;
  let inserted = false;

  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) throw new Error("invalid JPEG segment marker");
    const marker = buf[i + 1];
    if (marker === 0xda) {
      if (!inserted) {
        parts.push(buildXmpSegment(newPacket));
        inserted = true;
      }
      parts.push(buf.subarray(i));
      return Buffer.concat(parts);
    }
    if (marker === 0xd9) {
      parts.push(buf.subarray(i));
      return Buffer.concat(parts);
    }
    const segLen = buf.readUInt16BE(i + 2);
    const segEnd = i + 2 + segLen;
    const seg = buf.subarray(i, segEnd);

    const isXmp =
      marker === 0xe1 &&
      seg.length >= 4 + XMP_MARKER.length &&
      seg.subarray(4, 4 + XMP_MARKER.length).equals(XMP_MARKER);

    if (isXmp) {
      if (!inserted) {
        parts.push(buildXmpSegment(newPacket));
        inserted = true;
      }
    } else {
      parts.push(seg);
      if (!inserted && marker !== 0xe0 && marker !== 0xe1) {
        // insert XMP after APP0/APP1 cluster, before other segments
        parts.splice(parts.length - 1, 0, buildXmpSegment(newPacket));
        inserted = true;
      }
    }

    i = segEnd;
  }
  if (!inserted) parts.push(buildXmpSegment(newPacket));
  return Buffer.concat(parts);
}

function buildXmpSegment(packet: Buffer): Buffer {
  const payload = Buffer.concat([XMP_MARKER, packet]);
  const len = payload.length + 2;
  if (len > 0xffff) throw new Error("XMP packet too large for single APP1 segment");
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = 0xe1;
  header.writeUInt16BE(len, 2);
  return Buffer.concat([header, payload]);
}
