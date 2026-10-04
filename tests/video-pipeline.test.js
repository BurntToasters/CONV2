const test = require('node:test');
const assert = require('node:assert/strict');
const { planVideoPipeline, applyVideoFilter } = require('../dist/main/videoPipeline.js');

// Failure modes for colour / bit-depth / GPU-frame decisions. Written before videoPipeline.ts.
//  - HDR into an 8-bit target keeps PQ/HLG tags (washed out) or skips tone-mapping
//  - tone-mapping is attempted with frames still on the GPU (software filter cannot read them)
//  - tone-mapping requested when zscale is missing (FFmpeg fails with "No such filter")
//  - HDR into 10-bit CPU H.265/AV1 loses 10-bit or HDR tags
//  - 10-bit into hardware H.264 keeps GPU frames, so NVENC/QSV reject p010
//  - SDR sources gain spurious filters or lose their colour tags
//  - unknown/garbage colour values are passed to FFmpeg

const HDR10 = {
  pixFmt: 'yuv420p10le',
  colorPrimaries: 'bt2020',
  colorTransfer: 'smpte2084',
  colorSpace: 'bt2020nc',
  colorRange: 'tv',
};
const HLG = { ...HDR10, colorTransfer: 'arib-std-b67' };
const SDR8 = {
  pixFmt: 'yuv420p',
  colorPrimaries: 'bt709',
  colorTransfer: 'bt709',
  colorSpace: 'bt709',
  colorRange: 'tv',
};
const SDR10 = { ...SDR8, pixFmt: 'yuv420p10le' };
const CUDA = ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-c:v', 'hevc_cuvid'];
const VT = ['-hwaccel', 'videotoolbox', '-c:v', 'hevc'];

const plan = (overrides) =>
  planVideoPipeline({
    category: 'h264',
    encodeVendor: 'cpu',
    source: SDR8,
    decodeArgs: [],
    canTonemap: true,
    ...overrides,
  });
const argValue = (args, flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

test('HDR10 and HLG into H.264, AVI, and GIF are tone-mapped to BT.709', () => {
  for (const source of [HDR10, HLG]) {
    for (const category of ['h264', 'avi', 'gif']) {
      const result = plan({ category, source });
      assert.equal(result.tonemapped, true, `${category} ${source.colorTransfer}`);
      assert.match(result.filter, /tonemap/);
      assert.match(result.filter, /format=yuv420p$/);
      assert.equal(argValue(result.outputArgs, '-color_trc'), 'bt709');
      assert.equal(argValue(result.outputArgs, '-color_primaries'), 'bt709');
      assert.equal(argValue(result.outputArgs, '-colorspace'), 'bt709');
    }
  }
});

test('tone-mapping moves frames off the GPU but keeps hardware decode', () => {
  const result = plan({ source: HDR10, encodeVendor: 'nvidia', decodeArgs: CUDA });
  assert.equal(result.tonemapped, true);
  assert.deepEqual(result.decodeArgs, ['-hwaccel', 'cuda', '-c:v', 'hevc_cuvid']);
});

test('without zscale, HDR passes through tagged and warns instead of failing', () => {
  const result = plan({ source: HDR10, canTonemap: false });
  assert.equal(result.tonemapped, false);
  assert.equal(result.filter, undefined);
  assert.equal(argValue(result.outputArgs, '-color_trc'), 'smpte2084');
  assert.match(result.warning, /tone/i);
});

test('HDR into CPU H.265 and AV1 keeps 10-bit and HDR tags, no tone-mapping', () => {
  for (const category of ['h265', 'av1']) {
    const result = plan({ category, source: HDR10 });
    assert.equal(result.tonemapped, false);
    assert.equal(argValue(result.outputArgs, '-pix_fmt'), 'yuv420p10le');
    assert.equal(argValue(result.outputArgs, '-color_trc'), 'smpte2084');
    assert.equal(argValue(result.outputArgs, '-color_primaries'), 'bt2020');
  }
});

test('HDR into hardware H.265 keeps tags and lets the encoder pick its pixel format', () => {
  const result = plan({ category: 'h265', source: HDR10, encodeVendor: 'apple', decodeArgs: VT });
  assert.equal(result.tonemapped, false);
  assert.equal(argValue(result.outputArgs, '-pix_fmt'), undefined);
  assert.equal(argValue(result.outputArgs, '-color_trc'), 'smpte2084');
  assert.deepEqual(result.decodeArgs, VT);
});

test('10-bit SDR into hardware H.264 downloads frames and forces 8-bit', () => {
  for (const vendor of ['nvidia', 'intel', 'amd']) {
    const result = plan({ source: SDR10, encodeVendor: vendor, decodeArgs: CUDA });
    assert.equal(argValue(result.outputArgs, '-pix_fmt'), 'yuv420p', vendor);
    assert.ok(!result.decodeArgs.includes('-hwaccel_output_format'), vendor);
  }
});

test('same plan applies to the software-decode retry', () => {
  const first = plan({ source: SDR10, encodeVendor: 'nvidia', decodeArgs: CUDA });
  const retry = plan({ source: SDR10, encodeVendor: 'nvidia', decodeArgs: [] });
  assert.deepEqual(retry.outputArgs, first.outputArgs);
});

test('8-bit SDR keeps GPU frames, gets no filter, and keeps its tags', () => {
  const result = plan({ source: SDR8, encodeVendor: 'nvidia', decodeArgs: CUDA });
  assert.deepEqual(result.decodeArgs, CUDA);
  assert.equal(result.filter, undefined);
  assert.equal(result.tonemapped, false);
  assert.equal(argValue(result.outputArgs, '-color_trc'), 'bt709');
});

test('unknown or unsafe colour values are dropped', () => {
  const result = plan({
    source: { ...SDR8, colorTransfer: 'unknown', colorPrimaries: 'bt709;rm -rf', colorSpace: '' },
  });
  assert.equal(argValue(result.outputArgs, '-color_trc'), undefined);
  assert.equal(argValue(result.outputArgs, '-color_primaries'), undefined);
  assert.equal(argValue(result.outputArgs, '-colorspace'), undefined);
});

test('missing probe info yields a no-op plan', () => {
  const result = planVideoPipeline({
    category: 'h264',
    encodeVendor: 'cpu',
    source: undefined,
    decodeArgs: CUDA,
    canTonemap: true,
  });
  assert.deepEqual(result, { decodeArgs: CUDA, outputArgs: [], tonemapped: false });
});

test('filter is inserted before the output path, or prepended inside a GIF filter graph', () => {
  const simple = applyVideoFilter(['-i', 'in.mkv', '-c:v', 'libx264', 'out.mp4'], 'F');
  assert.deepEqual(simple, ['-i', 'in.mkv', '-c:v', 'libx264', '-vf', 'F', 'out.mp4']);
  const gif = applyVideoFilter(
    ['-i', 'in.mkv', '-filter_complex', '[0:v]fps=10,split[a][b]', 'out.gif'],
    'F'
  );
  assert.equal(gif[gif.indexOf('-filter_complex') + 1], '[0:v]F,fps=10,split[a][b]');
  const existing = applyVideoFilter(['-i', 'a', '-vf', 'scale=640:-2', 'o.mp4'], 'F');
  assert.equal(existing[existing.indexOf('-vf') + 1], 'F,scale=640:-2');
});
