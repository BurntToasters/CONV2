const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getQualityArgs,
  encodeEffortFromCpuPreset,
  getPresetById,
} = require('../dist/main/presets.js');

// Failure modes for hardware encoder speed/quality tiers. Written before the change.
//  - every NVENC tier runs p7 + full-res two-pass, so "Fast" is as slow as "Best Quality"
//  - a fast tier still pays for lookahead / two-pass on QSV or NVENC
//  - AV1 NVENC/QSV receive options they reject (tune hq, spatial/temporal AQ, lookahead)
//  - an unknown or user-edited CPU preset crashes or maps to nonsense
//  - callers that pass no effort silently change behaviour

const argAfter = (args, flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

test('x264/x265 preset names map to an effort level', () => {
  assert.equal(encodeEffortFromCpuPreset('veryslow'), 'max');
  assert.equal(encodeEffortFromCpuPreset('placebo'), 'max');
  assert.equal(encodeEffortFromCpuPreset('slow'), 'high');
  assert.equal(encodeEffortFromCpuPreset('medium'), 'balanced');
  for (const name of ['fast', 'faster', 'veryfast', 'superfast', 'ultrafast']) {
    assert.equal(encodeEffortFromCpuPreset(name), 'fast', name);
  }
});

test('SVT-AV1 numeric presets map to an effort level', () => {
  assert.equal(encodeEffortFromCpuPreset(2), 'max');
  assert.equal(encodeEffortFromCpuPreset(4), 'high');
  assert.equal(encodeEffortFromCpuPreset(6), 'balanced');
  assert.equal(encodeEffortFromCpuPreset(10), 'fast');
});

test('unknown presets fall back to balanced', () => {
  for (const value of ['nonsense', '', undefined, null, NaN, -1, {}]) {
    assert.equal(encodeEffortFromCpuPreset(value), 'balanced', String(value));
  }
});

test('NVENC preset and multipass scale with effort', () => {
  const expected = {
    max: ['p7', 'fullres'],
    high: ['p6', 'qres'],
    balanced: ['p5', 'disabled'],
    fast: ['p4', 'disabled'],
  };
  for (const [effort, [preset, multipass]] of Object.entries(expected)) {
    const args = getQualityArgs('nvidia', 23, 'h265', effort);
    assert.equal(argAfter(args, '-preset'), preset, effort);
    assert.equal(argAfter(args, '-multipass'), multipass, effort);
    assert.equal(argAfter(args, '-b:v'), '0', 'CQ mode');
  }
});

test('AV1 NVENC never gets tune hq or AQ at any effort', () => {
  for (const effort of ['max', 'high', 'balanced', 'fast']) {
    const args = getQualityArgs('nvidia', 30, 'av1', effort);
    assert.ok(!args.includes('-tune') && !args.includes('-spatial_aq'), effort);
  }
});

test('QSV lookahead shrinks with effort and is never used for AV1 or fast', () => {
  assert.equal(argAfter(getQualityArgs('intel', 23, 'h264', 'max'), '-look_ahead_depth'), '60');
  assert.equal(
    argAfter(getQualityArgs('intel', 23, 'h264', 'balanced'), '-look_ahead_depth'),
    '25'
  );
  assert.ok(!getQualityArgs('intel', 23, 'h264', 'fast').includes('-look_ahead'));
  assert.ok(!getQualityArgs('intel', 23, 'av1', 'max').includes('-look_ahead'));
  assert.equal(argAfter(getQualityArgs('intel', 23, 'h265', 'fast'), '-preset'), 'faster');
});

test('AMF quality mode follows effort', () => {
  assert.equal(argAfter(getQualityArgs('amd', 23, 'h264', 'max'), '-quality'), 'quality');
  assert.equal(argAfter(getQualityArgs('amd', 23, 'h264', 'balanced'), '-quality'), 'balanced');
  assert.equal(argAfter(getQualityArgs('amd', 23, 'h264', 'fast'), '-quality'), 'speed');
});

test('VideoToolbox prioritises speed only on fast tiers', () => {
  assert.equal(argAfter(getQualityArgs('apple', 23, 'h264', 'fast'), '-prio_speed'), '1');
  assert.ok(!getQualityArgs('apple', 23, 'h264', 'max').includes('-prio_speed'));
});

test('no effort argument keeps the previous max-quality behaviour', () => {
  assert.deepEqual(
    getQualityArgs('nvidia', 23, 'h264'),
    getQualityArgs('nvidia', 23, 'h264', 'max')
  );
});

test('built-in presets pass their tier effort to the hardware encoder', () => {
  const fast = getPresetById('h264-fast').getArgs('in.mp4', 'out.mp4', 'nvidia');
  assert.equal(argAfter(fast, '-multipass'), 'disabled');
  const best = getPresetById('h265-best-quality').getArgs('in.mp4', 'out.mp4', 'nvidia');
  assert.equal(argAfter(best, '-preset'), 'p7');
  assert.equal(argAfter(best, '-multipass'), 'fullres');
  const av1 = getPresetById('av1-balanced').getArgs('in.mp4', 'out.mp4', 'nvidia');
  assert.equal(argAfter(av1, '-preset'), 'p5');
});

test('CPU encodes are unaffected by effort', () => {
  assert.deepEqual(getQualityArgs('cpu', 23, 'h264', 'fast'), ['-crf', '23']);
  const cpu = getPresetById('h264-fast').getArgs('in.mp4', 'out.mp4', 'cpu');
  assert.equal(argAfter(cpu, '-preset'), 'fast');
});
