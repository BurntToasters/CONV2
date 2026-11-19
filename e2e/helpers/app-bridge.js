import { browser } from "@wdio/globals";

// The WebDriver bridge fails on script results containing non-ASCII text, so
// the page returns ASCII-escaped JSON and Node parses it.
async function callInPage(target, method, args) {
  const encoded = await browser.executeAsync(
    (scope, name, params, done) => {
      const ascii = (value) =>
        JSON.stringify(value).replace(
          /[\u0080-\uffff]/g,
          (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
        );
      Promise.resolve()
        .then(() => window.__CONV2_E2E__[scope][name](...params))
        .then(
          (value) => done(ascii({ ok: true, value: value ?? null })),
          (error) =>
            done(
              ascii({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
        );
    },
    target,
    method,
    args,
  );
  const outcome = JSON.parse(encoded);
  if (!outcome.ok) {
    throw new Error(
      `window.__CONV2_E2E__.${target}.${method} failed: ${outcome.error}`,
    );
  }
  return outcome.value;
}

/** Call a renderer API method (the same object the UI uses). */
export const api = (method, ...args) => callInPage("api", method, args);

/** Call an E2E-only helper (collectors and dialog stubs). */
export const helper = (method, ...args) => callInPage("helpers", method, args);

/**
 * Wait until the page and the E2E hook are ready. A visible "CONV2 Could Not
 * Start" modal means startup failed for good, so it fails at once with the
 * app's own explanation instead of timing out after a minute.
 */
export async function waitForAppReady() {
  let startupFailure = null;
  await browser.waitUntil(
    async () => {
      const state = await browser.execute(() => {
        const modal = document.getElementById("dynamicModal");
        const title = document.getElementById("dynamicModalTitle");
        const failed =
          Boolean(modal?.classList.contains("visible")) &&
          /could not start/i.test(title?.textContent ?? "");
        return {
          failure: failed
            ? (modal.querySelector(".modal-body")?.textContent ?? "").trim()
            : null,
          ready:
            Boolean(window.__CONV2_E2E__?.ready) &&
            Boolean(window.__CONV2_E2E__?.api) &&
            Boolean(document.getElementById("dropZone")),
        };
      });
      // Reported after the wait, so the failure is this error and not a wrapped timeout.
      if (state.failure !== null) {
        startupFailure = state.failure;
        return true;
      }
      return state.ready;
    },
    {
      timeout: 60_000,
      timeoutMsg: "E2E hook / window.__CONV2_E2E__.api not installed",
    },
  );
  if (startupFailure !== null) {
    throw new Error(`CONV2 Could Not Start: ${startupFailure}`);
  }
}
