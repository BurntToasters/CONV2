// Shared E2E helpers: FFmpeg discovery, deterministic fixtures, probing, artifacts.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const ARTIFACT_DIR = path.join(ROOT, 'coverage', 'e2e');
const EXE = process.platform === 'win32' ? '.exe' : '';
const PLATFORM_DIR = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform];

const isRunnable = (binary) => {
  try {
    execFileSync(binary, ['-version'], { stdio: 'ignore', timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
};

/** Bundled payload first, then CONV2_FFMPEG_PATH / CONV2_FFPROBE_PATH (absolute only). */
function findFFmpeg() {
  const bundledDir = path.join(ROOT, 'resources', 'ffmpeg', PLATFORM_DIR || '', process.arch);
  const candidates = [
    {
      source: 'bundled',
      ffmpeg: path.join(bundledDir, `ffmpeg${EXE}`),
      ffprobe: path.join(bundledDir, `ffprobe${EXE}`),
    },
    {
      source: 'env',
      ffmpeg: process.env.CONV2_FFMPEG_PATH,
      ffprobe: process.env.CONV2_FFPROBE_PATH,
    },
  ];
  for (const c of candidates) {
    if (!c.ffmpeg || !c.ffprobe || !path.isAbsolute(c.ffmpeg) || !path.isAbsolute(c.ffprobe)) {
      continue;
    }
    if (isRunnable(c.ffmpeg) && isRunnable(c.ffprobe)) {
      const version = execFileSync(c.ffmpeg, ['-version'], { encoding: 'utf8' }).split('\n')[0];
      return { ...c, version };
    }
  }
  return null;
}

const FFMPEG = findFFmpeg();
const REQUIRED = process.env.CONV2_REQUIRE_FFMPEG_TESTS === '1';

/** node:test skip value; throws when E2E is required but no FFmpeg is runnable. */
function ffmpegSkipReason() {
  if (FFMPEG) return false;
  const reason =
    'no runnable FFmpeg: add the bundled payload or set CONV2_FFMPEG_PATH/CONV2_FFPROBE_PATH';
  if (REQUIRED) throw new Error(`CONV2_REQUIRE_FFMPEG_TESTS=1 but ${reason}`);
  return reason;
}

const run = (binary, args, timeout = 120_000) =>
  execFileSync(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout });

const ffmpeg = (args) => run(FFMPEG.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args]);

function probe(file) {
  const raw = run(FFMPEG.ffprobe, [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    file,
  ]).toString();
  const data = JSON.parse(raw);
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const rotation = video?.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation;
  return {
    formatName: data.format?.format_name,
    duration: Number(data.format?.duration || 0),
    videoCodec: video?.codec_name,
    videoTag: video?.codec_tag_string,
    pixFmt: video?.pix_fmt,
    width: video?.width,
    height: video?.height,
    colorTransfer: video?.color_transfer,
    colorPrimaries: video?.color_primaries,
    rotation: rotation ?? 0,
    audioCodec: audio?.codec_name,
    audioChannels: audio?.channels,
    audioStreams: streams.filter((s) => s.codec_type === 'audio').length,
    subtitleCodecs: streams.filter((s) => s.codec_type === 'subtitle').map((s) => s.codec_name),
  };
}

const LAVFI_VIDEO = (seconds, size = '320x240') => [
  '-f',
  'lavfi',
  '-i',
  `testsrc2=size=${size}:rate=24:duration=${seconds}`,
];
const LAVFI_AUDIO = (seconds, layout = 'stereo') => [
  '-f',
  'lavfi',
  '-i',
  `sine=frequency=440:sample_rate=48000:duration=${seconds},aformat=channel_layouts=${layout}`,
];

/** Deterministic fixtures covering the edge cases the converter must survive. */
function createFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const out = (name) => path.join(dir, name);
  const f = {
    standard: out('standard.mp4'),
    long: out('long.mp4'),
    audioOnly: out('audio-only.mp4'),
    rotated: out('rotated.mp4'),
    hdr10: out('hdr10.mkv'),
    surround: out('surround-5.1.mkv'),
    subtitled: out('subtitled.mkv'),
    corrupt: out('corrupt.mp4'),
    unicode: out('ünïcode clip ✓.mp4'),
  };
  const h264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
  const aac = ['-c:a', 'aac', '-b:a', '96k'];

  ffmpeg([...LAVFI_VIDEO(2), ...LAVFI_AUDIO(2), ...h264, ...aac, '-shortest', f.standard]);
  ffmpeg([...LAVFI_VIDEO(40, '640x360'), ...LAVFI_AUDIO(40), ...h264, ...aac, f.long]);
  ffmpeg([...LAVFI_AUDIO(2), ...aac, f.audioOnly]);
  ffmpeg(['-display_rotation', '90', '-i', f.standard, '-c', 'copy', f.rotated]);
  ffmpeg([
    ...LAVFI_VIDEO(2),
    '-vf',
    'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv',
    '-c:v',
    'libx265',
    '-preset',
    'ultrafast',
    '-x265-params',
    'log-level=error:hdr10=1:repeat-headers=1:max-cll=1000,400:' +
      'master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)',
    '-pix_fmt',
    'yuv420p10le',
    f.hdr10,
  ]);
  ffmpeg([...LAVFI_VIDEO(2), ...LAVFI_AUDIO(2, '5.1'), ...h264, ...aac, '-shortest', f.surround]);
  const srt = out('subs.srt');
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:01,500\nHello\n');
  ffmpeg(['-i', f.standard, '-i', srt, '-map', '0', '-map', '1', '-c', 'copy', f.subtitled]);
  fs.writeFileSync(f.corrupt, Buffer.alloc(4096, 0x5a));
  fs.copyFileSync(f.standard, f.unicode);
  return f;
}

const mkTemp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `conv2-e2e-${label}-`));

/** Writes one JSON artifact under coverage/e2e and returns its path. */
function writeArtifact(name, data) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

module.exports = {
  ROOT,
  ARTIFACT_DIR,
  FFMPEG,
  ffmpegSkipReason,
  ffmpeg,
  probe,
  createFixtures,
  mkTemp,
  writeArtifact,
};
