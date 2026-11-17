import * as fs from 'fs';

export type VaapiVendor = 'intel' | 'amd';

export interface VaapiDeviceDeps {
  readdir?: (dir: string) => string[];
  readFile?: (file: string) => string;
}

const DRM_DIR = '/sys/class/drm';
const RENDER_NODE = /^renderD(\d+)$/;
// PCI vendor ids as exposed in /sys/class/drm/<node>/device/vendor.
const VENDOR_IDS: Record<VaapiVendor, string> = {
  intel: '0x8086',
  amd: '0x1002',
};

/**
 * Returns the lowest-numbered /dev/dri/renderD* node owned by the vendor, or null.
 * A node whose vendor file cannot be read is skipped.
 */
export const findVaapiRenderNode = (
  gpu: VaapiVendor,
  deps: VaapiDeviceDeps = {}
): string | null => {
  const readdir = deps.readdir ?? ((dir: string) => fs.readdirSync(dir));
  const readFile = deps.readFile ?? ((file: string) => fs.readFileSync(file, 'utf8'));
  let names: string[];
  try {
    names = readdir(DRM_DIR);
  } catch {
    return null;
  }

  const nodes = names
    .map((name) => ({ name, match: RENDER_NODE.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));

  for (const node of nodes) {
    try {
      const vendor = readFile(`${DRM_DIR}/${node.name}/device/vendor`).trim().toLowerCase();
      if (vendor === VENDOR_IDS[gpu]) return `/dev/dri/${node.name}`;
    } catch {
      // Unreadable vendor file: this node cannot be matched, so try the next one.
    }
  }
  return null;
};
