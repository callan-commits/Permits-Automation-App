import { describe, expect, it } from 'vitest';
import { ServiceRegister, guessFromLayerName, infoFromData, normaliseOwner, parseQl, tokenize } from '../src/services/register';
import type { CadDrawing, CadFeature } from '../src/cad/types';

describe('layer name guessing', () => {
  const cases: [string, string | null, string | null, boolean][] = [
    // layer, type, owner, overhead
    ['COMMS-TELSTRA', 'Comms', 'Telstra', false],
    ['COMMS-NBN', 'Comms', 'NBN Co', false],
    ['ELEC-HV-UE', 'Elec', 'United Energy', false],
    ['ELEC-LV-UE', 'Elec', 'United Energy', false],
    ['GAS-MULTINET', 'Gas', 'Multinet Gas', false],
    ['WATER-SEW', 'Water', 'South East Water', false],
    ['SEWER-SEW', 'Sewer', 'South East Water', false],
    ['DRAINAGE', 'Drainage', null, false],
    ['RAIL-SIGNAL-CABLE', 'Signalling', null, false],
    ['TELSTRA_QLB', 'Comms', 'Telstra', false],
    ['E_HV_OH', 'Elec', null, true],
    ['OH-ELEC-JEMENA', 'Elec', 'Jemena', true],
    ['O/H Power', 'Elec', null, true],
    ['MTM_SIGNALLING', 'Signalling', 'Metro Trains Melbourne', false],
    ['VicTrack Comms', 'Comms', 'VicTrack', false],
    ['OHLE', 'Traction power', null, true],
    ['Melbourne Water Drain', 'Drainage', 'Melbourne Water', false],
    ['ZINFRA', null, 'Zinfra', false],
    ['UNKNOWN SERVICE', null, null, false],
    ['HOTEL', null, null, false], // no false match on "TEL" inside a word
    ['0', null, null, false],
  ];
  it.each(cases)('%s', (layer, type, owner, overhead) => {
    const g = guessFromLayerName(layer);
    expect([g.type, g.owner, g.overhead]).toEqual([type, owner, overhead]);
  });

  it('reads quality levels from layer names', () => {
    expect(guessFromLayerName('TELSTRA_QLB').ql).toBe('B');
    expect(guessFromLayerName('GAS QL-A').ql).toBe('A');
    expect(guessFromLayerName('GAS-MULTINET').ql).toBeNull();
  });

  it('tokenises camelCase and punctuation', () => {
    expect(tokenize('ElecHV_OH-UE')).toEqual(['ELEC', 'HV', 'OH', 'UE']);
  });
});

describe('quality levels and owner names', () => {
  it.each([
    ['QL-B', 'B'],
    ['QLA', 'A'],
    ['b', 'B'],
    ['Quality Level C', 'C'],
    ['QL B', 'B'],
    ['QUALITY', null],
    ['', null],
  ])('parseQl(%s)', (raw, ql) => expect(parseQl(raw)).toBe(ql));

  it('normalises owner aliases and leaves unknown owners as written', () => {
    expect(normaliseOwner('mtm')).toBe('Metro Trains Melbourne');
    expect(normaliseOwner('Metro Trains')).toBe('Metro Trains Melbourne');
    expect(normaliseOwner('TELSTRA')).toBe('Telstra');
    expect(normaliseOwner(' Acme Pipes ')).toBe('Acme Pipes');
  });
});

describe('object data', () => {
  it('reads owner, type, QL and description from attributes and XDATA fields', () => {
    expect(infoFromData({ attributes: { OWNER: 'TELSTRA', PIT_ID: 'P1' } })).toMatchObject({ owner: 'Telstra', type: null });
    expect(infoFromData({ fields: { OWNER: 'Multinet Gas', SERVICE: 'Gas', SIZE: '150 PE', QL: 'A' } })).toEqual({
      owner: 'Multinet Gas',
      type: 'Gas',
      ql: 'A',
      description: '150 PE',
    });
    expect(infoFromData({ fields: { 'Asset Owner': 'vicTrack', 'Utility Type': 'Communications', 'Quality Level': 'QL-B' } })).toMatchObject({
      owner: 'VicTrack',
      type: 'Comms',
      ql: 'B',
    });
  });
});

const line = (layer: string, meta?: CadFeature['meta']): CadFeature => ({
  kind: 'line',
  layer,
  color: '#fff',
  entityType: 'LWPOLYLINE',
  handle: '1',
  coords: [[0, 0], [1, 0]],
  ...(meta ? { meta } : {}),
});

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe('resolution order', () => {
  it('object data beats layer edit beats layer name; per-object edit beats all', () => {
    const reg = new ServiceRegister(memoryStorage());
    const f = line('COMMS-TELSTRA', { fields: { OWNER: 'NBN' } });
    expect(reg.resolve(f)).toMatchObject({ owner: 'NBN Co', type: 'Comms', source: { owner: 'data', type: 'layer-name' } });
    reg.setLayer('COMMS-TELSTRA', { owner: 'Optus' });
    expect(reg.resolve(f).owner).toBe('NBN Co'); // data still wins for this object
    expect(reg.resolve(line('COMMS-TELSTRA')).owner).toBe('Optus'); // objects without data follow the layer edit
    expect(reg.resolve(f, { owner: 'VicTrack' })).toMatchObject({ owner: 'VicTrack', source: { owner: 'edit' } });
  });

  it('infers type from a single-service owner', () => {
    const reg = new ServiceRegister(memoryStorage());
    expect(reg.resolve(line('XYZ', { attributes: { OWNER: 'Telstra' } }))).toMatchObject({ type: 'Comms', source: { type: 'owner' } });
  });

  it('leaves unknowns null so they can be highlighted', () => {
    const reg = new ServiceRegister(memoryStorage());
    expect(reg.resolve(line('UNKNOWN SERVICE'))).toMatchObject({ type: null, owner: null, overhead: false });
  });

  it('remembers layer edits across sessions and can reset them', () => {
    const store = memoryStorage();
    const a = new ServiceRegister(store);
    a.setLayer('UNKNOWN SERVICE', { type: 'Water', owner: 'yvw', overhead: false });
    const b = new ServiceRegister(store);
    expect(b.resolve(line('UNKNOWN SERVICE'))).toMatchObject({ type: 'Water', owner: 'Yarra Valley Water', overhead: false });
    b.setLayer('UNKNOWN SERVICE', { type: '' });
    expect(b.layerSetting('UNKNOWN SERVICE')).toEqual({ owner: 'Yarra Valley Water', overhead: false });
    b.resetLayer('UNKNOWN SERVICE');
    expect(new ServiceRegister(store).layerSetting('UNKNOWN SERVICE')).toEqual({});
  });

  it('overhead can be set per layer', () => {
    const reg = new ServiceRegister(memoryStorage());
    expect(reg.isOverhead('ELEC-POLE')).toBe(false);
    reg.setLayer('ELEC-POLE', { overhead: true });
    expect(reg.isOverhead('ELEC-POLE')).toBe(true);
    expect(reg.resolve(line('ELEC-POLE')).overhead).toBe(true);
  });
});

describe('layer summary', () => {
  it('flags layers with unknown owner or type', () => {
    const reg = new ServiceRegister(memoryStorage());
    const drawing = {
      layers: ['COMMS-TELSTRA', 'DRAINAGE', 'UTIL-TEXT'].map((name) => ({ name, color: '#fff', hiddenInDrawing: false, featureCount: 1 })),
      features: [
        line('COMMS-TELSTRA'),
        line('DRAINAGE'),
        { kind: 'text', layer: 'UTIL-TEXT', color: '#fff', entityType: 'TEXT', handle: '2', coord: [0, 0], text: 'X', height: 1, rotation: 0, hAlign: 'left', vAlign: 'baseline' },
      ],
    } as unknown as CadDrawing;
    const rows = reg.summarise(drawing);
    expect(rows.map((r) => [r.layer, r.incomplete])).toEqual([
      ['COMMS-TELSTRA', false],
      ['DRAINAGE', true], // owner unknown
    ]); // text-only layers are not services
  });
});
