import type { GPUCodec, GPUVendor } from './presets';

export const getAutoVendorPriority = (platform: string): GPUVendor[] => {
  if (platform === 'darwin') {
    return ['apple', 'intel', 'amd', 'nvidia', 'cpu'];
  }
  return ['nvidia', 'intel', 'amd', 'apple', 'cpu'];
};

export const recommendGpuVendorFromAvailability = (
  platform: string,
  requestedCodec: GPUCodec | null,
  availabilityByVendor: Record<GPUVendor, boolean>
): { vendor: GPUVendor; reason: string } => {
  if (!requestedCodec) {
    return {
      vendor: 'cpu',
      reason: 'Preset does not use GPU-accelerated video encoding.',
    };
  }

  const priority = getAutoVendorPriority(platform);
  const selected = priority.find((vendor) => availabilityByVendor[vendor]);

  if (selected) {
    return {
      vendor: selected,
      reason:
        selected === 'cpu'
          ? 'No compatible GPU encoder found. Using CPU.'
          : `Best available path: ${selected}.`,
    };
  }

  return {
    vendor: 'cpu',
    reason: 'No compatible GPU encoder found. Using CPU.',
  };
};
