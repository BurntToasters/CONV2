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
//  - animated WebP receives HDR tags or skips tone-mapping, so colours wash out

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

test('HDR10 and HLG into H.264, AVI, GIF, and WebP are tone-mapped to BT.709', () => {
  for (const source of [HDR10, HLG]) {
    for (const category of ['h264', 'avi', 'gif', 'webp']) {
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

// Failure modes for the VAAPI upload chain. Written before the change.
//  - 10-bit HEVC/AV1 is uploaded as nv12, dropping the 10-bit depth
//  - 8-bit or H.264 frames are uploaded as p010, which VAAPI H.264 rejects
//  - the upload runs before tone-mapping, so zscale receives GPU frames
//  - a VAAPI plan emits -pix_fmt, which fights the upload filter's format conversion
//  - VAAPI H.264 keeps the software-frame rewrite that NVENC/QSV need

const { vaapiUploadFilter, TONEMAP_FILTER } = require('../dist/main/videoPipeline.js');

test('vaapiUploadFilter uploads p010 for 10-bit HEVC and AV1, nv12 otherwise', () => {
  const upload = (category, codec, sourcePixFmt) =>
    vaapiUploadFilter({ category, codec, sourcePixFmt });
  assert.equal(upload('h265', 'h265', 'yuv420p10le'), 'format=p010,hwupload');
  assert.equal(upload('av1', 'av1', 'yuv420p10le'), 'format=p010,hwupload');
  assert.equal(upload('h265', 'h265', 'yuv420p'), 'format=nv12,hwupload');
  assert.equal(upload('av1', 'av1', undefined), 'format=nv12,hwupload');
  assert.equal(upload('h264', 'h264', 'yuv420p10le'), 'format=nv12,hwupload');
});

test('VAAPI plans never emit -pix_fmt, whatever the bit depth or HDR state', () => {
  for (const category of ['h264', 'h265', 'av1']) {
    for (const source of [SDR8, SDR10, HDR10]) {
      const result = plan({ category, source, encodeVendor: 'vaapi' });
      assert.equal(
        argValue(result.outputArgs, '-pix_fmt'),
        undefined,
        `${category} ${source.pixFmt}`
      );
    }
  }
});

test('VAAPI H.264 HDR is tone-mapped into 8-bit and keeps the device path', () => {
  const result = plan({ category: 'h264', source: HDR10, encodeVendor: 'vaapi' });
  assert.equal(result.tonemapped, true);
  assert.equal(result.filter, TONEMAP_FILTER);
  const sdr10 = plan({ category: 'h264', source: SDR10, encodeVendor: 'vaapi', decodeArgs: [] });
  assert.deepEqual(sdr10.decodeArgs, []);
  assert.equal(sdr10.tonemapped, false);
});

test('the VAAPI upload is the last filter, after any tone-map', () => {
  const upload = vaapiUploadFilter({
    category: 'h264',
    codec: 'h264',
    sourcePixFmt: 'yuv420p10le',
  });
  const sdr = applyVideoFilter(['-i', 'in.mkv', '-c:v', 'h264_vaapi', 'out.mp4'], upload);
  assert.equal(argValue(sdr, '-vf'), 'format=nv12,hwupload');
  const hdr = applyVideoFilter(sdr, TONEMAP_FILTER);
  assert.equal(argValue(hdr, '-vf'), `${TONEMAP_FILTER},format=nv12,hwupload`);
});

// Failure modes for Qualcomm Media Foundation planning and the AVI VAAPI follow-up. Written before the change.
//  - a Qualcomm plan lacks -pix_fmt nv12, so MF receives yuv420p or p010 frames and fails
//  - a Qualcomm plan emits nv12 twice, or a 10-bit pixel format alongside it
//  - HDR into Qualcomm H.264, H.265 or AV1 skips tone-mapping, so colours wash out
//  - Qualcomm keeps -hwaccel_output_format, so the filter graph receives GPU frames
//  - an AVI preset that encodes H.265 uploads p010 to VAAPI although its category is 8-bit
//  - p010 is chosen for a 10-bit source with an unrelated or missing codec

const countFlag = (args, flag) => args.filter((arg) => arg === flag).length;
const D3D_DECODE = ['-hwaccel', 'd3d11va', '-hwaccel_output_format', 'd3d11', '-c:v', 'hevc'];

test('Qualcomm plans emit -pix_fmt nv12 exactly once for every codec and bit depth', () => {
  for (const category of ['h264', 'h265', 'av1']) {
    for (const source of [SDR8, SDR10, HDR10]) {
      const result = plan({
        category,
        source,
        encodeVendor: 'qualcomm',
        decodeArgs: D3D_DECODE,
        canTonemap: false,
      });
      const label = `${category} ${source.pixFmt} ${source.colorTransfer}`;
      assert.equal(countFlag(result.outputArgs, '-pix_fmt'), 1, label);
      assert.equal(argValue(result.outputArgs, '-pix_fmt'), 'nv12', label);
    }
  }
});

test('HDR into Qualcomm H.264, H.265 and AV1 is tone-mapped to 8-bit', () => {
  for (const category of ['h264', 'h265', 'av1']) {
    for (const source of [HDR10, HLG]) {
      const result = plan({ category, source, encodeVendor: 'qualcomm' });
      const label = `${category} ${source.colorTransfer}`;
      assert.equal(result.tonemapped, true, label);
      assert.equal(result.filter, TONEMAP_FILTER, label);
      assert.equal(argValue(result.outputArgs, '-color_trc'), 'bt709', label);
      assert.equal(countFlag(result.outputArgs, '-pix_fmt'), 1, label);
    }
  }
});

test('Qualcomm plans drop hardware output frames so the filters read software frames', () => {
  const result = plan({
    category: 'h265',
    source: HDR10,
    encodeVendor: 'qualcomm',
    decodeArgs: D3D_DECODE,
  });
  assert.equal(result.decodeArgs.includes('-hwaccel_output_format'), false);
  assert.equal(result.decodeArgs.includes('-hwaccel'), true);
});

test('Qualcomm without zscale warns about HDR and still writes one nv12 output', () => {
  const result = plan({
    category: 'h265',
    source: HDR10,
    encodeVendor: 'qualcomm',
    canTonemap: false,
  });
  assert.equal(result.tonemapped, false);
  assert.ok(result.warning);
  assert.equal(countFlag(result.outputArgs, '-pix_fmt'), 1);
  assert.equal(argValue(result.outputArgs, '-pix_fmt'), 'nv12');
});

test('AVI with an H.265 codec uploads nv12 to VAAPI, because its category is 8-bit', () => {
  assert.equal(
    vaapiUploadFilter({ category: 'avi', codec: 'h265', sourcePixFmt: 'yuv420p10le' }),
    'format=nv12,hwupload'
  );
});

test('p010 needs a 10-bit source, an H.265 or AV1 codec, and a category outside the 8-bit set', () => {
  const upload = (category, codec, sourcePixFmt) =>
    vaapiUploadFilter({ category, codec, sourcePixFmt });
  assert.equal(upload('h265', 'h265', 'yuv420p10le'), 'format=p010,hwupload');
  assert.equal(upload('av1', 'av1', 'yuv420p10le'), 'format=p010,hwupload');
  assert.equal(upload('h265', 'h265', 'yuv420p'), 'format=nv12,hwupload');
  assert.equal(upload('avi', 'h264', 'yuv420p10le'), 'format=nv12,hwupload');
  assert.equal(upload('gif', '', 'yuv420p10le'), 'format=nv12,hwupload');
  assert.equal(upload('webp', '', 'yuv420p10le'), 'format=nv12,hwupload');
});
