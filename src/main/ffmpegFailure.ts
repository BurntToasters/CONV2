// Turns FFmpeg stderr into one actionable sentence; the raw tail stays available as detail.

const BANNER_LINE =
  /^\s*(?:ffmpeg version|built with|configuration:|lib(?:av|sw|post)\w*\s+\d|Copyright)/i;
const NOISE_LINE =
  /^\s*(?:Conversion failed!?|Error opening (?:input|output) files?:|Error opening (?:input|output) file\b|To ignore this|Error parsing options)/i;
const MAX_DETAIL_LINES = 40;
const MAX_FALLBACK_CHARS = 160;

export const NO_VIDEO_MESSAGE =
  'This file has no video track. Pick an Audio preset to extract its sound instead.';

const RULES: Array<{ test: RegExp; message: string | ((m: RegExpMatchArray) => string) }> = [
  {
    test: /Stream map '[^']*' matches no streams|Output file (?:#\d+ )?does not contain any stream/i,
    message: NO_VIDEO_MESSAGE,
  },
  {
    test: /No such file or directory/i,
    message: 'The file could not be found. It may have been moved, renamed, or deleted.',
  },
  {
    test: /Permission denied|Operation not permitted/i,
    message:
      "CONV2 doesn't have permission to read this file or write to the output folder. Choose another output folder.",
  },
  {
    test: /No space left on device|Disk quota exceeded/i,
    message: 'The output drive is full. Free up space or choose another output folder.',
  },
  {
    test: /Invalid data found when processing input|moov atom not found|EBML header parsing failed|could not find codec parameters|Invalid NAL unit size|End of file/i,
    message:
      "CONV2 couldn't read this file. It may be damaged, incomplete, or not a supported video.",
  },
  {
    test: /Unknown encoder '([^']+)'/i,
    message: (m) =>
      `This FFmpeg build does not include the ${m[1]} encoder needed for this preset.`,
  },
  {
    test: /Encoder not found/i,
    message: 'This FFmpeg build does not include the encoder needed for this preset.',
  },
  {
    test: /Could not write header|codec not currently supported in container|is not supported (?:in|by) (?:this|the) (?:container|muxer)|are supported for (?:WebM|MP4)/i,
    message:
      "The output format can't hold one of the streams in this file. Try an MKV preset or Remux to MKV.",
  },
  {
    test: /Error while opening encoder|OpenEncodeSessionEx failed|Error initializing output stream|Could not open encoder/i,
    message:
      'The encoder could not start with these settings. Try CPU encoding under Hardware Acceleration.',
  },
];

const meaningfulLines = (stderr: string): string[] =>
  stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0 && !BANNER_LINE.test(line));

/** Strips "[in#0 @ 0x...]" style prefixes and absolute paths from a line. */
const cleanLine = (line: string): string =>
  line
    .replace(/^\s*(?:\[[^\]]*@\s*0x[0-9a-f]+\]\s*)+/i, '')
    .replace(/0x[0-9a-f]{4,}/gi, '')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"]*[\\/]([^\\/\s'"]+)/g, '$1')
    .trim();

export const describeFFmpegFailure = (stderr: string | undefined): string => {
  const text = stderr ?? '';
  for (const rule of RULES) {
    const match = text.match(rule.test);
    if (match) return typeof rule.message === 'string' ? rule.message : rule.message(match);
  }
  const candidates = meaningfulLines(text).filter((line) => !NOISE_LINE.test(line));
  const last = candidates.length > 0 ? cleanLine(candidates[candidates.length - 1]) : '';
  if (!last) return 'FFmpeg stopped without an error message. Open Logs for details.';
  const clipped =
    last.length > MAX_FALLBACK_CHARS ? `${last.slice(0, MAX_FALLBACK_CHARS - 1)}…` : last;
  return `FFmpeg error: ${clipped}`;
};

/** Last lines of stderr without the version banner, for a "Details" view and logs. */
export const ffmpegErrorDetail = (stderr: string | undefined): string =>
  meaningfulLines(stderr ?? '')
    .slice(-MAX_DETAIL_LINES)
    .join('\n');
