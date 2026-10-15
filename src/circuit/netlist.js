import { HOLE_BY_ID } from './holes';

const PALETTE = ['#2a9d8f', '#e76f51', '#7b5cd6', '#e9a400', '#3a86ff',
  '#d6336c', '#52a447', '#c2185b', '#00897b', '#8d6e63'];

// Every breadboard strip is a conductor; jumper wires join two strips.
// Returns the nets plus a lookup from `${componentId}:${pinIndex}` to its net.
export function buildNetlist(components) {
  const parent = new Map();
  const find = s => {
    while (parent.get(s) !== s) s = parent.get(s);
    return s;
  };
  const add = s => { if (!parent.has(s)) parent.set(s, s); };

  for (const c of components) {
    const strips = c.pins.map(id => HOLE_BY_ID.get(id).strip);
    strips.forEach(add);
    if (c.type === 'wire') parent.set(find(strips[0]), find(strips[1]));
  }

  const groups = new Map();
  for (const c of components)
    c.pins.forEach((id, pin) => {
      const root = find(HOLE_BY_ID.get(id).strip);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push({ comp: c, pin });
    });

  const nets = [], pinNet = new Map();
  let n = 0, vcc = 0, gnd = 0;
  for (const pins of groups.values()) {
    const supply = pins.find(p => p.comp.type === 'battery');
    let name, color;
    if (supply?.pin === 0) { name = vcc++ ? `VCC${vcc}` : 'VCC'; color = '#d62828'; }
    else if (supply) { name = gnd++ ? `GND${gnd}` : 'GND'; color = '#7a7a7a'; }
    else { name = `N${++n}`; color = PALETTE[(n - 1) % PALETTE.length]; }

    const parts = pins.filter(p => p.comp.type !== 'wire');
    const net = { name, color, pins: parts, floating: parts.length < 2 };
    nets.push(net);
    for (const p of pins) pinNet.set(`${p.comp.id}:${p.pin}`, net);
  }
  return { nets, pinNet };
}
