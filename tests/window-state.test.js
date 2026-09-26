const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Failure modes for window size/position restore:
//  - a corrupt or hand-edited windowState.json crashes startup
//  - a tiny saved size makes the window unusable
//  - a position from a disconnected monitor opens the window off-screen
//  - saving after the window is destroyed throws during quit

const displays = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }];
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return { screen: { getAllDisplays: () => displays } };
  return originalLoad.call(this, request, parent, isMain);
};
const windowStatePath = require.resolve('../dist/main/windowState.js');
delete require.cache[windowStatePath];
const { loadWindowState, saveWindowState, isWindowBoundsOnScreen } = require(windowStatePath);
Module._load = originalLoad;

const withFile = (content, fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-winstate-'));
  const file = path.join(dir, 'windowState.json');
  if (content !== undefined) fs.writeFileSync(file, content);
  try {
    return fn(file, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('missing and corrupt files fall back to the default size', () => {
  for (const content of [undefined, '{', 'null', '[]']) {
    withFile(content, (file) => {
      const state = loadWindowState(file);
      assert.equal(state.width, 1080, String(content));
      assert.equal(state.height, 880);
    });
  }
});

test('sizes below the window minimum are replaced; bad coordinates are dropped', () => {
  withFile(
    JSON.stringify({ width: 200, height: 100, x: 'left', y: null, isMaximized: 'yes' }),
    (file) => {
      assert.deepEqual(loadWindowState(file), {
        width: 1080,
        height: 880,
        x: undefined,
        y: undefined,
        isMaximized: false,
      });
    }
  );
});

test('valid saved state round-trips', () => {
  withFile(undefined, (file) => {
    const fakeWindow = {
      isDestroyed: () => false,
      isMaximized: () => true,
      getNormalBounds: () => ({ x: 40, y: 50, width: 900, height: 700 }),
    };
    saveWindowState(fakeWindow, file);
    assert.deepEqual(loadWindowState(file), {
      width: 900,
      height: 700,
      x: 40,
      y: 50,
      isMaximized: true,
    });
  });
});

test('saving a destroyed or missing window is a no-op', () => {
  withFile(undefined, (file, dir) => {
    saveWindowState(null, file);
    saveWindowState({ isDestroyed: () => true }, file);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test('positions on a disconnected monitor are treated as off-screen', () => {
  assert.equal(isWindowBoundsOnScreen(100, 100, 800, 600), true);
  assert.equal(isWindowBoundsOnScreen(2500, 100, 800, 600), false);
  assert.equal(isWindowBoundsOnScreen(100, -2000, 800, 600), false);
});
