import type { ParseRequest, ParseResponse } from './worker';
import type { CadDrawing } from './types';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (d: CadDrawing) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<ParseResponse>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if (ev.data.ok) p.resolve(ev.data.drawing);
    else p.reject(new Error(ev.data.error));
  };
  worker.onerror = (ev) => {
    for (const p of pending.values()) p.reject(new Error(ev.message || 'DWG parser crashed'));
    pending.clear();
    worker?.terminate();
    worker = null; // a fresh worker is created for the next file
  };
  return worker;
}

/** Parse a DWG or DXF file in a background worker. */
export function loadCadFile(fileName: string, buffer: ArrayBuffer): Promise<CadDrawing> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const req: ParseRequest = { id, fileName, buffer };
    getWorker().postMessage(req, [buffer]);
  });
}
