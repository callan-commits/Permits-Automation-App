/**
 * AutoCAD Color Index (ACI) -> hex colour.
 *
 * Indices 1-9 are the standard named colours, 250-255 are greys, and 10-249
 * follow AutoCAD's hue wheel: 24 hues (15 deg apart) x 5 brightness levels,
 * alternating full and half saturation. The values closely match AutoCAD's table.
 */
const BASE: Record<number, string> = {
  1: '#ff0000',
  2: '#ffff00',
  3: '#00ff00',
  4: '#00ffff',
  5: '#0000ff',
  6: '#ff00ff',
  7: '#ffffff', // white on dark backgrounds (black on white in AutoCAD)
  8: '#808080',
  9: '#c0c0c0',
  250: '#333333',
  251: '#505050',
  252: '#696969',
  253: '#828282',
  254: '#bebebe',
  255: '#ffffff',
};

const VALUES = [1.0, 0.8, 0.6, 0.5, 0.3];

function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const hex = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export function aciToHex(index: number): string {
  if (BASE[index]) return BASE[index];
  if (index >= 10 && index <= 249) {
    const hue = Math.floor((index - 10) / 10) * 15;
    const k = index % 10;
    const value = VALUES[Math.floor(k / 2)];
    const saturation = k % 2 === 0 ? 1 : 0.5;
    return hsvToHex(hue, saturation, value);
  }
  return '#ffffff';
}

/** 24-bit true colour integer (0xRRGGBB) -> hex. */
export function trueColorToHex(rgb: number): string {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;
}
