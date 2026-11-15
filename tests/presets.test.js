const test = require('node:test');
const assert = require('node:assert/strict');

const {
  presets,
  getPresetById,
  ADVANCED_PRESET_CATEGORIES,
  getVisiblePresetCategories,
  getPresetGpuCodec,
  PRESET_CATEGORY_ORDER,
  PRESET_CATEGORY_LABELS,
  resolveEncodeVendor,
} = require('../dist/main/presets.js');
const { GPU_ENCODERS } = require('../dist/main/ffmpeg.js');

const requiredVendors = ['nvidia', 'amd', 'intel', 'qualcomm', 'apple', 'cpu'];

test('preset ids are unique', () => {
  const ids = presets.map((preset) => preset.id);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, ids.length);
});

test('getPresetById returns the matching preset', () => {
  const first = presets[0];
  assert.ok(first);
  const found = getPresetById(first.id);
  assert.ok(found);
  assert.equal(found.id, first.id);
});

test('all GPU encoder mappings exist', () => {
  for (const codec of Object.keys(GPU_ENCODERS)) {
    for (const vendor of requiredVendors) {
      assert.ok(GPU_ENCODERS[codec][vendor], `${codec}.${vendor} is missing`);
    }
  }
});

test('video presets include expected encoders in args', () => {
  for (const preset of presets) {
    const codec = getPresetGpuCodec(preset);
    if (!codec) {
      continue;
    }
    const cpuArgs = preset.getArgs('input.mp4', `output.${preset.extension}`, 'cpu');
    assert.ok(cpuArgs.includes(GPU_ENCODERS[codec].cpu), `${preset.id} missing CPU encoder`);
    const nvidiaArgs = preset.getArgs('input.mp4', `output.${preset.extension}`, 'nvidia');
    assert.ok(
      nvidiaArgs.includes(GPU_ENCODERS[codec].nvidia),
      `${preset.id} missing NVIDIA encoder`
    );
  }
});

test('preset args end with the output path', () => {
  for (const preset of presets) {
    const output = `output.${preset.extension}`;
    const args = preset.getArgs('input.mp4', output, 'cpu');
    assert.equal(args[args.length - 1], output);
  }
});

test('gif presets exist with expected order and extension', () => {
  const gifPresets = presets.filter((preset) => preset.category === 'gif');
  assert.deepEqual(
    gifPresets.map((preset) => preset.id),
    ['gif-best-quality', 'gif-quality', 'gif-balanced', 'gif-best-compression']
  );
  assert.ok(gifPresets.every((preset) => preset.extension === 'gif'));
});

test('gif category is visible by default', () => {
  assert.equal(ADVANCED_PRESET_CATEGORIES.includes('gif'), false);
  assert.equal(getVisiblePresetCategories(false).includes('gif'), true);
  assert.equal(getVisiblePresetCategories(true).includes('gif'), true);
});

// Failure modes for the WebP category, written before the change.
//  - webp is missing from the category order, or sorted somewhere other than after gif
//  - the label is missing or shows the raw id
//  - webp is hidden behind the advanced toggle, or the category list drops gif

test('webp category sits right after gif, is labelled, and is visible by default', () => {
  assert.equal(PRESET_CATEGORY_ORDER.indexOf('webp'), PRESET_CATEGORY_ORDER.indexOf('gif') + 1);
  assert.equal(PRESET_CATEGORY_LABELS.webp, 'WebP (Animated)');
  assert.equal(ADVANCED_PRESET_CATEGORIES.includes('webp'), false);
  assert.equal(getVisiblePresetCategories(false).includes('webp'), true);
  assert.equal(getVisiblePresetCategories(false).includes('gif'), true);
});

test('avi category still requires advanced presets', () => {
  assert.ok(ADVANCED_PRESET_CATEGORIES.includes('avi'));
  assert.equal(getVisiblePresetCategories(false).includes('avi'), false);
  assert.equal(getVisiblePresetCategories(true).includes('avi'), true);
});

test('preset categories export labels and stable ordering', () => {
  assert.ok(PRESET_CATEGORY_ORDER.includes('gif'));
  assert.equal(PRESET_CATEGORY_LABELS.gif, 'GIF');
  assert.equal(PRESET_CATEGORY_LABELS.h265, 'H.265/HEVC');
});

test('avi gpu codec resolution follows advanced format settings context', () => {
  const preset = presets.find((entry) => entry.id === 'avi-balanced');
  assert.ok(preset);

  const defaultCodec = getPresetGpuCodec(preset);
  assert.equal(defaultCodec, 'h264');

  const overriddenCodec = getPresetGpuCodec(preset, {
    advancedFormatSettings: {
      avi: {
        tiers: {
          balanced: {
            codec: 'h265',
          },
        },
      },
    },
  });
  assert.equal(overriddenCodec, 'h265');
});

test('avi presets carry explicit tier metadata', () => {
  const aviPresets = presets.filter((entry) => entry.category === 'avi');
  const tierById = Object.fromEntries(aviPresets.map((entry) => [entry.id, entry.aviTier]));
  assert.deepEqual(tierById, {
    'avi-best-quality': 'bestQuality',
    'avi-best-compression': 'bestCompression',
    'avi-balanced': 'balanced',
  });
});

// getQualityArgs GPU-specific flags

const { getQualityArgs } = require('../dist/main/presets.js');

test('getQualityArgs: NVENC H.264 has cq, p7 preset, multipass, tune hq, spatial/temporal aq', () => {
  const args = getQualityArgs('nvidia', 23, 'h264');
  assert.ok(args.includes('-cq'));
  assert.equal(args[args.indexOf('-preset') + 1], 'p7');
  assert.equal(args[args.indexOf('-multipass') + 1], 'fullres');
  assert.equal(args[args.indexOf('-tune') + 1], 'hq');
  assert.ok(args.includes('-spatial_aq'));
  assert.ok(args.includes('-temporal_aq'));
});

test('getQualityArgs: NVENC AV1 omits tune/spatial_aq/temporal_aq', () => {
  const args = getQualityArgs('nvidia', 30, 'av1');
  assert.ok(!args.includes('-tune'));
  assert.ok(!args.includes('-spatial_aq'));
  assert.ok(!args.includes('-temporal_aq'));
  assert.ok(args.includes('-multipass'));
});

test('getQualityArgs: AMF includes -quality quality preset', () => {
  const args = getQualityArgs('amd', 22, 'h265', 'max', 'win32');
  assert.ok(args.includes('-quality'));
  assert.equal(args[args.indexOf('-quality') + 1], 'quality');
});

test('getQualityArgs: Intel QSV H.264 includes look-ahead and extbrc', () => {
  const args = getQualityArgs('intel', 23, 'h264', 'max', 'win32');
  assert.ok(args.includes('-look_ahead'));
  assert.ok(args.includes('-look_ahead_depth'));
  assert.ok(args.includes('-extbrc'));
});

test('getQualityArgs: Intel QSV AV1 omits look-ahead and extbrc', () => {
  const args = getQualityArgs('intel', 30, 'av1', 'max', 'win32');
  assert.ok(!args.includes('-look_ahead'));
  assert.ok(!args.includes('-extbrc'));
  assert.ok(args.includes('-global_quality'));
});

test('getQualityArgs: Apple VT uses -q:v, -allow_sw 1, -realtime 0', () => {
  const args = getQualityArgs('apple', 23, 'h264');
  assert.ok(args.includes('-q:v'));
  assert.equal(args[args.indexOf('-allow_sw') + 1], '1');
  assert.equal(args[args.indexOf('-realtime') + 1], '0');
  assert.ok(!args.includes('-crf'));
});

test('getQualityArgs: CPU uses -crf', () => {
  const args = getQualityArgs('cpu', 23, 'h264');
  assert.equal(args[args.indexOf('-crf') + 1], '23');
});

// pix_fmt for H.264 CPU

test('H.264 CPU preset includes -pix_fmt yuv420p', () => {
  const preset = presets.find((p) => p.id === 'h264-fast');
  const args = preset.getArgs('/input.mp4', '/output.mp4', 'cpu');
  assert.ok(args.includes('-pix_fmt'));
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
});

test('H.264 NVENC preset does NOT include -pix_fmt', () => {
  const preset = presets.find((p) => p.id === 'h264-fast');
  const args = preset.getArgs('/input.mp4', '/output.mp4', 'nvidia');
  assert.ok(!args.includes('-pix_fmt'));
});

test('AVI balanced (H.264 CPU) includes -pix_fmt yuv420p', () => {
  const preset = presets.find((p) => p.id === 'avi-balanced');
  const args = preset.getArgs('/input.mp4', '/output.avi', 'cpu');
  assert.ok(args.includes('-pix_fmt'), 'avi-balanced H.264 CPU must force yuv420p');
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
});

test('AVI best-quality (H.264 CPU) includes -pix_fmt yuv420p', () => {
  const preset = presets.find((p) => p.id === 'avi-best-quality');
  const args = preset.getArgs('/input.mp4', '/output.avi', 'cpu');
  assert.ok(
    args.includes('-pix_fmt'),
    'avi-best-quality now defaults to H.264 and must force yuv420p'
  );
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
});

test('AVI presets use MP3 audio (libmp3lame), not AAC', () => {
  for (const id of ['avi-best-quality', 'avi-best-compression', 'avi-balanced']) {
    const preset = presets.find((p) => p.id === id);
    assert.ok(preset, `missing ${id}`);
    const args = preset.getArgs('/input.mp4', '/output.avi', 'cpu');
    assert.equal(args[args.indexOf('-c:a') + 1], 'libmp3lame', `${id}: AVI audio must be MP3`);
    assert.ok(!args.includes('aac'), `${id}: AVI must not use AAC audio`);
  }
});

// GIF filter quality

test('GIF best-quality filter includes stats_mode=full', () => {
  const preset = presets.find((p) => p.id === 'gif-best-quality');
  const args = preset.getArgs('/input.mp4', '/output.gif', 'cpu');
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.ok(filter.includes('stats_mode=full'));
});

test('GIF filter includes diff_mode=rectangle', () => {
  const preset = presets.find((p) => p.id === 'gif-balanced');
  const args = preset.getArgs('/input.mp4', '/output.gif', 'cpu');
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.ok(filter.includes('diff_mode=rectangle'));
});

test('GIF bayer tier includes bayer_scale=5', () => {
  for (const preset of presets.filter((p) => p.category === 'gif')) {
    const args = preset.getArgs('/input.mp4', '/output.gif', 'cpu');
    const filter = args[args.indexOf('-filter_complex') + 1];
    if (filter.includes('dither=bayer')) {
      assert.ok(filter.includes('bayer_scale=5'), `${preset.id}: bayer dither needs bayer_scale=5`);
    }
  }
});

// Remux + audio metadata

test('remux-mp4 preserves metadata with -map_metadata 0', () => {
  const preset = presets.find((p) => p.id === 'remux-mp4');
  const args = preset.getArgs('/in.mkv', '/out.mp4', 'cpu');
  assert.ok(args.includes('-map_metadata'));
  assert.equal(args[args.indexOf('-map_metadata') + 1], '0');
});

test('remux-mkv and remux-webm preserve metadata', () => {
  for (const id of ['remux-mkv', 'remux-webm']) {
    const preset = presets.find((p) => p.id === id);
    const args = preset.getArgs('/in.mp4', '/out.' + preset.extension, 'cpu');
    assert.ok(args.includes('-map_metadata'), `${id} needs -map_metadata`);
  }
});

test('audio-mp3 uses VBR (-q:a 2) not CBR', () => {
  const preset = presets.find((p) => p.id === 'audio-mp3');
  const args = preset.getArgs('/in.mp4', '/out.mp3', 'cpu');
  assert.ok(args.includes('-q:a'));
  assert.equal(args[args.indexOf('-q:a') + 1], '2');
  assert.ok(!args.includes('-b:a'));
});

test('all audio presets preserve metadata with -map_metadata 0', () => {
  for (const id of ['audio-mp3', 'audio-aac', 'audio-flac']) {
    const preset = presets.find((p) => p.id === id);
    const args = preset.getArgs('/in.mp4', '/out.' + preset.extension, 'cpu');
    assert.ok(args.includes('-map_metadata'), `${id} needs -map_metadata`);
  }
});

// Failure modes for VAAPI routing on Linux Intel/AMD. Written before the change.
//  - Linux Intel or AMD still resolve to QSV or AMF encoder names
//  - Windows or macOS resolve to VAAPI encoder names
//  - VAAPI rate control uses the wrong flags, or -global_quality is outside 1..51
//  - AV1 VAAPI quality is not scaled by 4, or leaves the 1..255 range
//  - VAAPI output carries -pix_fmt, which would conflict with the hwupload filter chain
//  - Linux NVIDIA or CPU encodes are routed to VAAPI
//  - Apple AV1 stops mapping to CPU

const { usesVaapi, resolveEncoder } = require('../dist/main/gpuEncoders.js');

const vaapiFlag = (args, flag) => args[args.indexOf(flag) + 1];
const byId = (id) => presets.find((preset) => preset.id === id);

test('usesVaapi is true only for Intel and AMD on Linux', () => {
  assert.equal(usesVaapi('intel', 'linux'), true);
  assert.equal(usesVaapi('amd', 'linux'), true);
  for (const gpu of ['nvidia', 'apple', 'cpu']) {
    assert.equal(usesVaapi(gpu, 'linux'), false, gpu);
  }
  for (const platform of ['win32', 'darwin']) {
    assert.equal(usesVaapi('intel', platform), false, platform);
    assert.equal(usesVaapi('amd', platform), false, platform);
  }
});

test('resolveEncoder maps Linux Intel and AMD to VAAPI encoders', () => {
  for (const gpu of ['intel', 'amd']) {
    assert.equal(resolveEncoder('h264', gpu, 'linux'), 'h264_vaapi', gpu);
    assert.equal(resolveEncoder('h265', gpu, 'linux'), 'hevc_vaapi', gpu);
    assert.equal(resolveEncoder('av1', gpu, 'linux'), 'av1_vaapi', gpu);
  }
});

test('resolveEncoder keeps Quick Sync, AMF, and every other vendor unchanged', () => {
  assert.equal(resolveEncoder('h264', 'intel', 'win32'), 'h264_qsv');
  assert.equal(resolveEncoder('h265', 'intel', 'win32'), 'hevc_qsv');
  assert.equal(resolveEncoder('av1', 'intel', 'win32'), 'av1_qsv');
  assert.equal(resolveEncoder('h264', 'amd', 'win32'), 'h264_amf');
  assert.equal(resolveEncoder('h265', 'amd', 'win32'), 'hevc_amf');
  assert.equal(resolveEncoder('av1', 'amd', 'win32'), 'av1_amf');
  assert.equal(resolveEncoder('h264', 'nvidia', 'linux'), 'h264_nvenc');
  assert.equal(resolveEncoder('h264', 'apple', 'darwin'), 'h264_videotoolbox');
  assert.equal(resolveEncoder('av1', 'apple', 'darwin'), 'libsvtav1');
  assert.equal(resolveEncoder('h264', 'cpu', 'linux'), 'libx264');
});

test('resolveEncodeVendor reports vaapi only for Linux Intel and AMD', () => {
  assert.equal(resolveEncodeVendor('h264', 'intel', 'linux'), 'vaapi');
  assert.equal(resolveEncodeVendor('av1', 'amd', 'linux'), 'vaapi');
  assert.equal(resolveEncodeVendor('av1', 'apple', 'darwin'), 'cpu');
  assert.equal(resolveEncodeVendor('h265', 'intel', 'win32'), 'intel');
});

test('VAAPI H.264 and H.265 use CQP with the QP value, clamped to 1..51', () => {
  assert.deepEqual(getQualityArgs('intel', 23, 'h264', 'max', 'linux'), [
    '-rc_mode',
    'CQP',
    '-global_quality',
    '23',
  ]);
  assert.deepEqual(getQualityArgs('amd', 22, 'h265', 'fast', 'linux'), [
    '-rc_mode',
    'CQP',
    '-global_quality',
    '22',
  ]);
  assert.equal(
    vaapiFlag(getQualityArgs('intel', 63, 'h264', 'max', 'linux'), '-global_quality'),
    '51'
  );
  assert.equal(
    vaapiFlag(getQualityArgs('intel', 0, 'h265', 'max', 'linux'), '-global_quality'),
    '1'
  );
});

test('VAAPI quality ignores the effort tier', () => {
  const efforts = ['max', 'high', 'balanced', 'fast'];
  const first = getQualityArgs('amd', 30, 'h264', efforts[0], 'linux');
  for (const effort of efforts) {
    assert.deepEqual(getQualityArgs('amd', 30, 'h264', effort, 'linux'), first, effort);
  }
});

test('VAAPI AV1 scales the clamped QP by 4 and stays within 1..255', () => {
  assert.equal(
    vaapiFlag(getQualityArgs('intel', 30, 'av1', 'max', 'linux'), '-global_quality'),
    '120'
  );
  // The QP is clamped to 51 before scaling, so a CRF-range 63 becomes 204.
  assert.equal(
    vaapiFlag(getQualityArgs('amd', 63, 'av1', 'max', 'linux'), '-global_quality'),
    '204'
  );
  assert.equal(
    vaapiFlag(getQualityArgs('intel', 0, 'av1', 'max', 'linux'), '-global_quality'),
    '4'
  );
  for (let quality = -5; quality <= 100; quality += 1) {
    const value = Number(
      vaapiFlag(getQualityArgs('intel', quality, 'av1', 'max', 'linux'), '-global_quality')
    );
    assert.ok(value >= 1 && value <= 255, `quality ${quality} gave ${value}`);
  }
});

test('every VAAPI video preset uses its VAAPI encoder and never sets -pix_fmt', () => {
  const expected = { h264: 'h264_vaapi', h265: 'hevc_vaapi', av1: 'av1_vaapi' };
  for (const gpu of ['intel', 'amd']) {
    for (const preset of presets) {
      const codec = getPresetGpuCodec(preset);
      if (!codec) continue;
      const args = preset.getArgs('input.mp4', `output.${preset.extension}`, gpu, {
        platform: 'linux',
      });
      const label = `${preset.id}/${gpu}`;
      assert.equal(vaapiFlag(args, '-c:v'), expected[codec], label);
      assert.equal(args.includes('-pix_fmt'), false, label);
      assert.equal(vaapiFlag(args, '-rc_mode'), 'CQP', label);
    }
  }
});

test('VAAPI follows the AVI tier codec', () => {
  const args = byId('avi-balanced').getArgs('input.mp4', 'output.avi', 'intel', {
    platform: 'linux',
    advancedFormatSettings: { avi: { tiers: { balanced: { codec: 'h265' } } } },
  });
  assert.equal(vaapiFlag(args, '-c:v'), 'hevc_vaapi');
});

test('Windows Intel and AMD presets keep Quick Sync and AMF encoders', () => {
  const intel = byId('h264-fast').getArgs('in.mp4', 'out.mp4', 'intel', { platform: 'win32' });
  assert.equal(vaapiFlag(intel, '-c:v'), 'h264_qsv');
  const amd = byId('h264-fast').getArgs('in.mp4', 'out.mp4', 'amd', { platform: 'win32' });
  assert.equal(vaapiFlag(amd, '-c:v'), 'h264_amf');
});

// Failure modes for Qualcomm Media Foundation arguments. Written before the change.
//  - a Qualcomm encoder name other than h264_mf, hevc_mf or av1_mf reaches FFmpeg
//  - Qualcomm quality arguments carry -preset, -crf or CPU tuning, which MF rejects
//  - the Qualcomm -quality value leaves 1..100 at either end of the 0..51 QP range
//  - extracting the shared Apple mapping changes VideoToolbox quality values
//  - Qualcomm presets emit a CPU pixel format, bypassing the pipeline's single nv12

const flagValue = (args, flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

test('Qualcomm maps to Media Foundation encoders for each codec', () => {
  assert.equal(GPU_ENCODERS.h264.qualcomm, 'h264_mf');
  assert.equal(GPU_ENCODERS.h265.qualcomm, 'hevc_mf');
  assert.equal(GPU_ENCODERS.av1.qualcomm, 'av1_mf');
});

test('Qualcomm quality args map the QP range onto -quality 1..100', () => {
  const at = (qp) => getQualityArgs('qualcomm', qp, 'h264', 'max', 'win32');
  assert.deepEqual(at(0), ['-hw_encoding', '1', '-rate_control', 'quality', '-quality', '100']);
  assert.equal(flagValue(at(51), '-quality'), '1');
  assert.equal(flagValue(at(26), '-quality'), '49');
  assert.equal(flagValue(at(25), '-quality'), '51');
  assert.equal(flagValue(at(80), '-quality'), '1', 'QP above 51 clamps');
  assert.equal(flagValue(at(-4), '-quality'), '100', 'QP below 0 clamps');
});

test('Qualcomm quality matches the Apple mapping for every QP', () => {
  for (let qp = 0; qp <= 51; qp += 1) {
    const apple = getQualityArgs('apple', qp, 'h264', 'max', 'darwin');
    const qualcomm = getQualityArgs('qualcomm', qp, 'h264', 'max', 'win32');
    assert.equal(flagValue(qualcomm, '-quality'), flagValue(apple, '-q:v'), `qp ${qp}`);
  }
});

test('Qualcomm quality args ignore effort and codec and carry no CPU or preset flags', () => {
  const reference = getQualityArgs('qualcomm', 30, 'h264', 'max', 'win32');
  for (const codec of ['h264', 'h265', 'av1']) {
    for (const effort of ['max', 'high', 'balanced', 'fast']) {
      assert.deepEqual(getQualityArgs('qualcomm', 30, codec, effort, 'win32'), reference);
    }
  }
  for (const flag of ['-preset', '-crf', '-tune', '-pix_fmt', '-prio_speed', '-svtav1-params']) {
    assert.equal(reference.includes(flag), false, flag);
  }
});

test('Apple quality args stay byte-identical after the shared mapping is extracted', () => {
  assert.deepEqual(getQualityArgs('apple', 26, 'h264', 'max', 'darwin'), [
    '-q:v',
    '49',
    '-allow_sw',
    '1',
    '-realtime',
    '0',
  ]);
});

test('resolveEncodeVendor keeps Qualcomm as the hardware vendor for every codec', () => {
  for (const codec of ['h264', 'h265', 'av1']) {
    assert.equal(resolveEncodeVendor(codec, 'qualcomm', 'win32'), 'qualcomm', codec);
  }
});

test('Qualcomm presets select the MF encoder and skip CPU-only flags', () => {
  const cases = [
    ['h264-quality', 'h264_mf'],
    ['h265-balanced', 'hevc_mf'],
    ['av1-balanced', 'av1_mf'],
    ['avi-balanced', 'h264_mf'],
  ];
  for (const [id, encoder] of cases) {
    const preset = getPresetById(id);
    const args = preset.getArgs('in.mkv', 'out.mp4', 'qualcomm', { platform: 'win32' });
    assert.equal(flagValue(args, '-c:v'), encoder, id);
    for (const flag of ['-preset', '-crf', '-svtav1-params', '-x265-params', '-pix_fmt']) {
      assert.equal(args.includes(flag), false, `${id} ${flag}`);
    }
    assert.equal(flagValue(args, '-hw_encoding'), '1', id);
  }
});
