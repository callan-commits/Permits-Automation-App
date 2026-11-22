/// <reference lib="webworker" />
/**
 * Web Worker: parses DWG/DXF with LibreDWG (WebAssembly) and converts it to map geometry.
 * Runs off the main thread so large surveys don't freeze the UI. Files never leave the browser.
 */
import { createModule, Dwg_File_Type, LibreDwg } from '@mlightcad/libredwg-web';
// The package's exports map hides its .wasm file, so reference it by path. Vite copies it into the build.
import wasmUrl from '../../node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.wasm?url';
import { convertDatabase } from './convert';
import type { CadDrawing } from './types';

export interface ParseRequest {
  id: number;
  fileName: string;
  buffer: ArrayBuffer;
}

export type ParseResponse =
  | { id: number; ok: true; drawing: CadDrawing }
  | { id: number; ok: false; error: string }
  | { id: number; stage: string };

let libPromise: Promise<ReturnType<typeof LibreDwg.createByWasmInstance>> | null = null;

function getLib() {
  libPromise ??= createModule({ locateFile: () => wasmUrl }).then((inst) => LibreDwg.createByWasmInstance(inst));
  return libPromise;
}

export function detectFileType(fileName: string, bytes: Uint8Array): 'dwg' | 'dxf' | 'binary-dxf' {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 22));
  if (head.startsWith('AC10') || head.startsWith('AC1.')) return 'dwg';
  if (head.startsWith('AutoCAD Binary DXF')) return 'binary-dxf';
  return fileName.toLowerCase().endsWith('.dwg') ? 'dwg' : 'dxf';
}

self.onmessage = async (ev: MessageEvent<ParseRequest>) => {
  const { id, fileName, buffer } = ev.data;
  const post = (msg: ParseResponse) => (self as unknown as Worker).postMessage(msg);
  const stage = (text: string) => post({ id, stage: text });
  try {
    stage('Starting DWG reader…');
    const lib = await getLib();
    const kind = detectFileType(fileName, new Uint8Array(buffer));
    if (kind === 'binary-dxf') throw new Error('Binary DXF is not supported. Save it as an ASCII DXF or a DWG.');
    const mb = (buffer.byteLength / 1e6).toFixed(1);
    stage(`Reading ${fileName} (${mb} MB)…`);
    const input = kind === 'dwg' ? buffer : new TextDecoder('utf-8').decode(buffer);
    const ptr = lib.dwg_read_data(input, kind === 'dwg' ? Dwg_File_Type.DWG : Dwg_File_Type.DXF);
    if (ptr === undefined || ptr === 0) throw new Error(`Could not read ${fileName}. The file may be corrupt or an unsupported version.`);
    let drawing: CadDrawing;
    try {
      stage('Extracting drawing objects…');
      const db = lib.convert(ptr);
      stage(`Converting ${db.entities.length.toLocaleString()} objects…`);
      drawing = convertDatabase(db, fileName);
    } finally {
      lib.dwg_free(ptr);
    }
    stage(`Sending ${drawing.features.length.toLocaleString()} objects to the map…`);
    post({ id, ok: true, drawing });
  } catch (err) {
    // A failed read can leave the WebAssembly reader in a bad state: start a fresh one next time.
    libPromise = null;
    post({ id, ok: false, error: (err as Error).message ?? String(err) });
  }
};
