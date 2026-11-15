const test = require('node:test');
const assert = require('node:assert/strict');

const { findVaapiRenderNode } = require('../dist/main/vaapiDevices.js');

// Failure modes for render-node discovery. Written before src/main/vaapiDevices.ts.
//  - Intel (0x8086) and AMD (0x1002) ids are swapped, or NVIDIA (0x10de) matches
//  - renderD9 loses to renderD128 because names are sorted as strings
//  - card0 or malformed names such as renderD-bogus are treated as render nodes
//  - a trailing newline or CRLF in the vendor file stops a match
//  - a missing /sys/class/drm or a throwing readdir escapes instead of returning null
//  - one unreadable vendor file stops the scan before a later matching node
//  - the vendor file is read from the wrong path

const DRM = '/sys/class/drm';

// Builds injected deps from a { renderName: vendorText } map, with the fake
// directory listing every entry in that map plus any extra names.
const fakeDrm = (vendors, extraNames = []) => {
  const reads = [];
  return {
    reads,
    deps: {
      readdir: (dir) => {
        assert.equal(dir, DRM);
        return [...Object.keys(vendors), ...extraNames];
      },
      readFile: (file) => {
        reads.push(file);
        const name = file.split('/')[4];
        if (!(name in vendors)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        if (vendors[name] instanceof Error) throw vendors[name];
        return vendors[name];
      },
    },
  };
};

test('returns the /dev/dri node whose vendor matches the requested GPU', () => {
  const intel = fakeDrm({ renderD128: '0x8086\n', renderD129: '0x1002\n' });
  assert.equal(findVaapiRenderNode('intel', intel.deps), '/dev/dri/renderD128');
  const amd = fakeDrm({ renderD128: '0x8086\n', renderD129: '0x1002\n' });
  assert.equal(findVaapiRenderNode('amd', amd.deps), '/dev/dri/renderD129');
});

test('reads /sys/class/drm/<node>/device/vendor and trims whitespace and CRLF', () => {
  const fake = fakeDrm({ renderD128: '  0x8086\r\n' });
  assert.equal(findVaapiRenderNode('intel', fake.deps), '/dev/dri/renderD128');
  assert.deepEqual(fake.reads, ['/sys/class/drm/renderD128/device/vendor']);
});

test('NVIDIA-only systems yield null for both Intel and AMD', () => {
  const fake = fakeDrm({ renderD128: '0x10de\n' });
  assert.equal(findVaapiRenderNode('intel', fake.deps), null);
  assert.equal(findVaapiRenderNode('amd', fake.deps), null);
});

test('the lowest-numbered matching node wins using numeric order', () => {
  // String order would put renderD128 before renderD9.
  const fake = fakeDrm({ renderD128: '0x8086\n', renderD9: '0x8086\n' });
  assert.equal(findVaapiRenderNode('intel', fake.deps), '/dev/dri/renderD9');
  // renderD128 is the lower number, even though renderD1290 is listed first.
  const longer = fakeDrm({ renderD1290: '0x8086\n', renderD128: '0x8086\n' });
  assert.equal(findVaapiRenderNode('intel', longer.deps), '/dev/dri/renderD128');
});

test('entries that are not renderD<number> are ignored', () => {
  const fake = fakeDrm({ card0: '0x8086\n', renderD128: '0x10de\n' }, ['renderD-bogus', 'renderD']);
  assert.equal(findVaapiRenderNode('intel', fake.deps), null);
  assert.equal(
    fake.reads.some((file) => file.includes('card0') || file.includes('bogus')),
    false
  );
});

test('a missing /sys/class/drm directory yields null', () => {
  const deps = {
    readdir: () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    readFile: () => '0x8086\n',
  };
  assert.equal(findVaapiRenderNode('intel', deps), null);
  assert.equal(findVaapiRenderNode('amd', deps), null);
});

test('an unreadable vendor file on the only node yields null', () => {
  const fake = fakeDrm({ renderD128: new Error('EACCES') });
  assert.equal(findVaapiRenderNode('intel', fake.deps), null);
});

test('an unreadable vendor file is skipped so a later matching node still wins', () => {
  const fake = fakeDrm({ renderD128: new Error('EACCES'), renderD129: '0x8086\n' });
  assert.equal(findVaapiRenderNode('intel', fake.deps), '/dev/dri/renderD129');
});

test('a node with no vendor file is skipped', () => {
  const fake = fakeDrm({ renderD129: '0x8086\n' }, ['renderD128']);
  assert.equal(findVaapiRenderNode('intel', fake.deps), '/dev/dri/renderD129');
});

test('no nodes at all yields null', () => {
  const fake = fakeDrm({});
  assert.equal(findVaapiRenderNode('amd', fake.deps), null);
});
