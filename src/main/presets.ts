export type GPUVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'cpu';

export interface Preset {
  id: string;
  name: string;
  description: string;
  category: 'av1' | 'h264' | 'h265' | 'remux' | 'audio' | 'custom';
  extension: string;
  getArgs: (inputFile: string, outputFile: string, gpu: GPUVendor) => string[];
}

const getVideoEncoder = (codec: 'h264' | 'h265' | 'av1', gpu: GPUVendor): string => {
  const encoders: Record<string, Record<GPUVendor, string>> = {
    h264: {
      nvidia: 'h264_nvenc',
      amd: 'h264_amf',
      intel: 'h264_qsv',
      apple: 'h264_videotoolbox',
      cpu: 'libx264',
    },
    h265: {
      nvidia: 'hevc_nvenc',
      amd: 'hevc_amf',
      intel: 'hevc_qsv',
      apple: 'hevc_videotoolbox',
      cpu: 'libx265',
    },
    av1: {
      nvidia: 'av1_nvenc',
      amd: 'av1_amf',
      intel: 'av1_qsv',
      apple: 'libsvtav1', // No AV1 hardware encoding support in ffmpeg for Apple Silicon yet
      cpu: 'libsvtav1',
    },
  };
  return encoders[codec][gpu];
};

export const presets: Preset[] = [
  // AV1 Presets
  {
    id: 'av1-balanced',
    name: 'AV1 - Balanced',
    description: 'Good balance between quality and file size',
    category: 'av1',
    extension: 'mp4',
    getArgs: (input, output, gpu) => {
      const encoder = getVideoEncoder('av1', gpu);
      if (gpu === 'cpu') {
        return ['-i', input, '-c:v', encoder, '-crf', '30', '-preset', '6', '-c:a', 'libopus', '-b:a', '128k', output];
      }
      return ['-i', input, '-c:v', encoder, '-cq', '30', '-c:a', 'libopus', '-b:a', '128k', output];
    },
  },
  {
    id: 'av1-quality',
    name: 'AV1 - Best Quality',
    description: 'Maximum quality, larger file size',
    category: 'av1',
    extension: 'mp4',
    getArgs: (input, output, gpu) => {
      const encoder = getVideoEncoder('av1', gpu);
      if (gpu === 'cpu') {
        return ['-i', input, '-c:v', encoder, '-crf', '20', '-preset', '4', '-c:a', 'libopus', '-b:a', '192k', output];
      }
      return ['-i', input, '-c:v', encoder, '-cq', '20', '-c:a', 'libopus', '-b:a', '192k', output];
    },
  },
  {
    id: 'av1-compression',
    name: 'AV1 - Best Compression',
    description: 'Smallest file size, slower encoding',
    category: 'av1',
    extension: 'mp4',
    getArgs: (input, output, gpu) => {
      const encoder = getVideoEncoder('av1', gpu);
      if (gpu === 'cpu') {
        return ['-i', input, '-c:v', encoder, '-crf', '40', '-preset', '6', '-c:a', 'libopus', '-b:a', '96k', output];
      }
      return ['-i', input, '-c:v', encoder, '-cq', '40', '-c:a', 'libopus', '-b:a', '96k', output];
    },
  },

  // H.264 Presets
  {
    id: 'h264-fast',
    name: 'H.264 - Fast',
    description: 'Quick encoding, universal compatibility',
    category: 'h264',
    extension: 'mp4',
    getArgs: (input, output, gpu) => {
      const encoder = getVideoEncoder('h264', gpu);
      if (gpu === 'cpu') {
        return ['-i', input, '-c:v', encoder, '-crf', '23', '-preset', 'fast', '-c:a', 'aac', '-b:a', '128k', output];
      }
      return ['-i', input, '-c:v', encoder, '-cq', '23', '-preset', 'fast', '-c:a', 'aac', '-b:a', '128k', output];
    },
  },
  {
    id: 'h264-quality',
    name: 'H.264 - Quality',
    description: 'Better quality H.264 encoding',
    category: 'h264',
    extension: 'mp4',
    getArgs: (input, output, gpu) => {
      const encoder = getVideoEncoder('h264', gpu);
      if (gpu === 'cpu') {
        return ['-i', input, '-c:v', encoder, '-crf', '18', '-preset', 'slow', '-c:a', 'aac', '-b:a', '192k', output];
      }
      return ['-i', input, '-c:v', encoder, '-cq', '18', '-preset', 'slow', '-c:a', 'aac', '-b:a', '192k', output];
    },
  },

  // H.265/HEVC Presets
  {
    id: 'h265-balanced',
    name: 'H.265/HEVC - Balanced',
    description: 'Good compression with wide device support',
    category: 'h265',
    extension: 'mp4',
    getArgs: (input, output, gpu) => {
      const encoder = getVideoEncoder('h265', gpu);
      if (gpu === 'cpu') {
        return ['-i', input, '-c:v', encoder, '-crf', '28', '-preset', 'medium', '-c:a', 'aac', '-b:a', '128k', output];
      }
      return ['-i', input, '-c:v', encoder, '-cq', '28', '-c:a', 'aac', '-b:a', '128k', output];
    },
  },
  {
    id: 'h265-quality',
    name: 'H.265/HEVC - Quality',
    description: 'High quality HEVC encoding',
    category: 'h265',
    extension: 'mp4',
    getArgs: (input, output, gpu) => {
      const encoder = getVideoEncoder('h265', gpu);
      if (gpu === 'cpu') {
        return ['-i', input, '-c:v', encoder, '-crf', '22', '-preset', 'slow', '-c:a', 'aac', '-b:a', '192k', output];
      }
      return ['-i', input, '-c:v', encoder, '-cq', '22', '-c:a', 'aac', '-b:a', '192k', output];
    },
  },

  // Remux Presets
  {
    id: 'remux-mp4',
    name: 'Remux to MP4',
    description: 'Copy streams to MP4 container (no re-encoding)',
    category: 'remux',
    extension: 'mp4',
    getArgs: (input, output) => ['-i', input, '-c', 'copy', output],
  },
  {
    id: 'remux-mkv',
    name: 'Remux to MKV',
    description: 'Copy streams to MKV container (no re-encoding)',
    category: 'remux',
    extension: 'mkv',
    getArgs: (input, output) => ['-i', input, '-c', 'copy', output],
  },
  {
    id: 'remux-webm',
    name: 'Remux to WebM',
    description: 'Copy streams to WebM container (no re-encoding)',
    category: 'remux',
    extension: 'webm',
    getArgs: (input, output) => ['-i', input, '-c', 'copy', output],
  },

  // Audio Extraction Presets
  {
    id: 'audio-mp3',
    name: 'Extract Audio (MP3)',
    description: 'Extract audio track as MP3',
    category: 'audio',
    extension: 'mp3',
    getArgs: (input, output) => ['-i', input, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', output],
  },
  {
    id: 'audio-aac',
    name: 'Extract Audio (AAC)',
    description: 'Extract audio track as AAC',
    category: 'audio',
    extension: 'aac',
    getArgs: (input, output) => ['-i', input, '-vn', '-c:a', 'aac', '-b:a', '192k', output],
  },
  {
    id: 'audio-flac',
    name: 'Extract Audio (FLAC)',
    description: 'Extract audio track as lossless FLAC',
    category: 'audio',
    extension: 'flac',
    getArgs: (input, output) => ['-i', input, '-vn', '-c:a', 'flac', output],
  },
];

export const getPresetById = (id: string): Preset | undefined => {
  return presets.find((p) => p.id === id);
};

export const getPresetsByCategory = (category: Preset['category']): Preset[] => {
  return presets.filter((p) => p.category === category);
};
