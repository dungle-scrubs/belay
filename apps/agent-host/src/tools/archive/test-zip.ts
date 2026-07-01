import { deflateRawSync } from "node:zlib";

export function storedZip(
  entries: ReadonlyArray<{
    readonly name: string;
    readonly content: string | Uint8Array;
  }>,
): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const content =
      typeof entry.content === "string" ? encoder.encode(entry.content) : entry.content;
    const header = new Uint8Array(30 + name.byteLength);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(8, 0, true);
    view.setUint32(18, content.byteLength, true);
    view.setUint32(22, content.byteLength, true);
    view.setUint16(26, name.byteLength, true);
    header.set(name, 30);
    chunks.push(header, content);
  }

  const end = new Uint8Array(22);
  new DataView(end.buffer).setUint32(0, 0x06054b50, true);
  chunks.push(end);
  return concat(chunks);
}

export function deflatedZip(entry: {
  readonly name: string;
  readonly content: string;
}): Uint8Array {
  const encoder = new TextEncoder();
  const name = encoder.encode(entry.name);
  const rawContent = encoder.encode(entry.content);
  const content = new Uint8Array(deflateRawSync(rawContent));
  const header = new Uint8Array(30 + name.byteLength);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(8, 8, true);
  view.setUint32(18, content.byteLength, true);
  view.setUint32(22, rawContent.byteLength, true);
  view.setUint16(26, name.byteLength, true);
  header.set(name, 30);
  const end = new Uint8Array(22);
  new DataView(end.buffer).setUint32(0, 0x06054b50, true);
  return concat([header, content, end]);
}

export function centralDirectoryZip(entry: {
  readonly name: string;
  readonly content: string;
  readonly externalAttributes?: number;
  readonly flags?: number;
}): Uint8Array {
  const encoder = new TextEncoder();
  const name = encoder.encode(entry.name);
  const content = encoder.encode(entry.content);
  const localHeader = new Uint8Array(30 + name.byteLength);
  const localView = new DataView(localHeader.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint16(6, entry.flags ?? 0, true);
  localView.setUint16(8, 0, true);
  localView.setUint32(18, content.byteLength, true);
  localView.setUint32(22, content.byteLength, true);
  localView.setUint16(26, name.byteLength, true);
  localHeader.set(name, 30);

  const centralHeader = new Uint8Array(46 + name.byteLength);
  const centralView = new DataView(centralHeader.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(4, 20, true);
  centralView.setUint16(6, 20, true);
  centralView.setUint16(8, entry.flags ?? 0, true);
  centralView.setUint16(10, 0, true);
  centralView.setUint32(20, content.byteLength, true);
  centralView.setUint32(24, content.byteLength, true);
  centralView.setUint16(28, name.byteLength, true);
  centralView.setUint32(38, entry.externalAttributes ?? 0, true);
  centralHeader.set(name, 46);

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, 1, true);
  endView.setUint16(10, 1, true);
  endView.setUint32(12, centralHeader.byteLength, true);
  endView.setUint32(16, localHeader.byteLength + content.byteLength, true);

  return concat([localHeader, content, centralHeader, end]);
}

export function tinyPng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
