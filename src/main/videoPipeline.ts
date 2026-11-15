// Decides colour tags, bit depth, tone-mapping, and whether decoded frames may stay on the GPU.

export interface SourceColor {
  pixFmt?: string;
  colorPrimaries?: string;
  colorTransfer?: string;
  colorSpace?: string;
  colorRange?: string;
}

export interface VideoPipelineInput {
  category: string;
  /** Vendor of the encoder actually used (after AV1-on-Apple etc. resolution). */
  encodeVendor: string;
  source: SourceColor | undefined;
  decodeArgs: string[];
  /** True when the FFmpeg build has zscale + tonemap. */
  canTonemap: boolean;
}

export interface VideoPipelinePlan {
  decodeArgs: string[];
  outputArgs: string[];
  filter?: string;
  tonemapped: boolean;
  warning?: string;
}

const EIGHT_BIT_CATEGORIES = new Set(['h264', 'avi', 'gif', 'webp']);
const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67']);
const SAFE_COLOR_VALUE = /^[a-z0-9-]+$/i;
const UNKNOWN_COLOR = new Set(['unknown', 'unspecified', 'reserved']);

// Linearise, map primaries, Hable tone curve, then back to BT.709 limited-range 8-bit.
export const TONEMAP_FILTER =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,' +
  'tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

const usableColor = (value: string | undefined): value is string =>
  typeof value === 'string' && SAFE_COLOR_VALUE.test(value) && !UNKNOWN_COLOR.has(value);

const isHighBitDepth = (pixFmt: string | undefined): boolean =>
  typeof pixFmt === 'string' && /(?:10|12|16)(?:le|be)?$|p010|p016/.test(pixFmt);

/** Drops -hwaccel_output_format so FFmpeg downloads decoded frames to system memory. */
const withSoftwareFrames = (decodeArgs: string[]): string[] => {
  const index = decodeArgs.indexOf('-hwaccel_output_format');
  if (index === -1) return decodeArgs;
  return [...decodeArgs.slice(0, index), ...decodeArgs.slice(index + 2)];
};

const colorTagArgs = (source: SourceColor): string[] => {
  const args: string[] = [];
  if (usableColor(source.colorPrimaries)) args.push('-color_primaries', source.colorPrimaries);
  if (usableColor(source.colorTransfer)) args.push('-color_trc', source.colorTransfer);
  if (usableColor(source.colorSpace)) args.push('-colorspace', source.colorSpace);
  if (usableColor(source.colorRange)) args.push('-color_range', source.colorRange);
  return args;
};

/**
 * Media Foundation hardware encoders take only 8-bit NV12, so Qualcomm is an 8-bit
 * target for every codec and its output always carries -pix_fmt nv12.
 */
const isMediaFoundation = (encodeVendor: string): boolean => encodeVendor === 'qualcomm';

export const planVideoPipeline = (input: VideoPipelineInput): VideoPipelinePlan => {
  const { category, encodeVendor, source, decodeArgs, canTonemap } = input;
  const mfNv12Args = isMediaFoundation(encodeVendor) ? ['-pix_fmt', 'nv12'] : [];
  if (!source) return { decodeArgs, outputArgs: mfNv12Args, tonemapped: false };

  const isHdr = usableColor(source.colorTransfer) && HDR_TRANSFERS.has(source.colorTransfer);
  const eightBitTarget = EIGHT_BIT_CATEGORIES.has(category) || isMediaFoundation(encodeVendor);
  const highBitDepth = isHighBitDepth(source.pixFmt);

  if (isHdr && eightBitTarget && canTonemap) {
    return {
      decodeArgs: withSoftwareFrames(decodeArgs),
      outputArgs: [
        '-color_primaries',
        'bt709',
        '-color_trc',
        'bt709',
        '-colorspace',
        'bt709',
        '-color_range',
        'tv',
        ...mfNv12Args,
      ],
      filter: TONEMAP_FILTER,
      tonemapped: true,
    };
  }

  const outputArgs = colorTagArgs(source);
  const plan: VideoPipelinePlan = { decodeArgs, outputArgs, tonemapped: false };
  if (isHdr && eightBitTarget) {
    plan.warning =
      'HDR source into an 8-bit format: this FFmpeg build cannot tone-map, colours may look washed out.';
  }

  if (highBitDepth && encodeVendor === 'cpu' && (category === 'h265' || category === 'av1')) {
    outputArgs.push('-pix_fmt', 'yuv420p10le');
  }
  // NVENC/QSV/AMF H.264 reject 10-bit GPU frames; VideoToolbox converts on its own.
  // VAAPI converts in its upload filter instead, so it never gets -pix_fmt.
  // Media Foundation takes NV12 below instead.
  if (
    highBitDepth &&
    category === 'h264' &&
    !['cpu', 'apple', 'vaapi', 'qualcomm'].includes(encodeVendor)
  ) {
    plan.decodeArgs = withSoftwareFrames(decodeArgs);
    outputArgs.push('-pix_fmt', 'yuv420p');
  }
  if (isMediaFoundation(encodeVendor)) {
    plan.decodeArgs = withSoftwareFrames(decodeArgs);
    outputArgs.push(...mfNv12Args);
  }
  return plan;
};

/**
 * Upload chain for VAAPI. p010 needs a 10-bit source, an H.265 or AV1 codec, and a
 * category outside the 8-bit set (an AVI preset that encodes H.265 is 8-bit).
 * Everything else is nv12. Appended after any tone-map, so the upload runs last.
 */
export const vaapiUploadFilter = ({
  category,
  codec,
  sourcePixFmt,
}: {
  category: string;
  codec: string;
  sourcePixFmt: string | undefined;
}): string => {
  const tenBit =
    (codec === 'h265' || codec === 'av1') &&
    isHighBitDepth(sourcePixFmt) &&
    !EIGHT_BIT_CATEGORIES.has(category);
  return tenBit ? 'format=p010,hwupload' : 'format=nv12,hwupload';
};

/** Adds a video filter before the output path, merging with an existing -vf or GIF graph. */
export const applyVideoFilter = (args: string[], filter: string): string[] => {
  const next = [...args];
  const graphIndex = next.indexOf('-filter_complex');
  if (graphIndex !== -1 && next[graphIndex + 1]?.startsWith('[0:v]')) {
    next[graphIndex + 1] = `[0:v]${filter},${next[graphIndex + 1].slice('[0:v]'.length)}`;
    return next;
  }
  const vfIndex = next.indexOf('-vf');
  if (vfIndex !== -1) {
    next[vfIndex + 1] = `${filter},${next[vfIndex + 1]}`;
    return next;
  }
  return [...next.slice(0, -1), '-vf', filter, next[next.length - 1]];
};
