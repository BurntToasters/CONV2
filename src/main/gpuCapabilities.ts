import { checkGPUEncoderSupport, GPU_ENCODERS } from './ffmpeg';
import { recommendGpuVendorFromAvailability } from './gpuRecommendation';
import type { GPUCodec, GPUVendor } from './presets';

// Per-codec vendor availability matrix for the GPU panel, plus the Auto recommendation.

interface GPUCapabilityStatus {
  available: boolean;
  reason: string;
  encoder: string;
}

type GPUCapabilityMatrix = Partial<Record<GPUCodec, Record<GPUVendor, GPUCapabilityStatus>>>;

export interface GPUCapabilitiesPayload {
  platform: NodeJS.Platform;
  requestedCodec: GPUCodec | null;
  checkedCodecs: GPUCodec[];
  matrix: GPUCapabilityMatrix;
  recommendedVendor: GPUVendor;
  recommendationReason: string;
}

const GPU_VENDORS: GPUVendor[] = ['nvidia', 'amd', 'intel', 'apple', 'cpu'];
const GPU_CODECS: GPUCodec[] = ['h264', 'h265', 'av1'];

const getRecommendedVendor = (
  platform: NodeJS.Platform,
  requestedCodec: GPUCodec | null,
  matrix: GPUCapabilityMatrix
): { vendor: GPUVendor; reason: string } => {
  if (!requestedCodec) {
    return {
      vendor: 'cpu',
      reason: 'Preset does not use GPU-accelerated video encoding.',
    };
  }

  const row = matrix[requestedCodec];
  if (!row) {
    return {
      vendor: 'cpu',
      reason: 'Capability data unavailable. Falling back to CPU.',
    };
  }

  const availabilityByVendor = GPU_VENDORS.reduce(
    (acc, vendor) => {
      acc[vendor] = row[vendor]?.available === true;
      return acc;
    },
    {} as Record<GPUVendor, boolean>
  );

  return recommendGpuVendorFromAvailability(platform, requestedCodec, availabilityByVendor);
};

export const buildGpuCapabilitiesPayload = async (
  requestedCodec: GPUCodec | null
): Promise<GPUCapabilitiesPayload> => {
  const codecsToCheck = requestedCodec ? [requestedCodec] : GPU_CODECS;
  const matrix: GPUCapabilityMatrix = {};

  for (const codec of codecsToCheck) {
    const vendorChecks = GPU_VENDORS.map(
      async (vendor): Promise<[GPUVendor, GPUCapabilityStatus]> => {
        if (vendor === 'cpu') {
          return [
            vendor,
            {
              available: true,
              reason: 'Software encoding fallback.',
              encoder: GPU_ENCODERS[codec].cpu,
            },
          ];
        }

        if (vendor === 'apple' && process.platform !== 'darwin') {
          return [
            vendor,
            {
              available: false,
              reason: 'Apple VideoToolbox available only on macOS.',
              encoder: GPU_ENCODERS[codec].apple,
            },
          ];
        }

        if (vendor === 'apple' && codec === 'av1') {
          return [
            vendor,
            {
              available: false,
              reason: 'Apple AV1 hardware encode unavailable. Use CPU for AV1.',
              encoder: GPU_ENCODERS[codec].apple,
            },
          ];
        }

        const check = await checkGPUEncoderSupport(vendor, codec);
        return [
          vendor,
          {
            available: check.available,
            reason: check.available ? 'Available' : check.error?.message || 'Unavailable',
            encoder: check.encoder || GPU_ENCODERS[codec][vendor],
          },
        ];
      }
    );

    const results = await Promise.all(vendorChecks);
    const row = {} as Record<GPUVendor, GPUCapabilityStatus>;
    for (const [vendor, status] of results) {
      row[vendor] = status;
    }
    matrix[codec] = row;
  }

  const recommendation = getRecommendedVendor(process.platform, requestedCodec, matrix);

  return {
    platform: process.platform,
    requestedCodec,
    checkedCodecs: codecsToCheck,
    matrix,
    recommendedVendor: recommendation.vendor,
    recommendationReason: recommendation.reason,
  };
};
