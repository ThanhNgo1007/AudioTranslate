const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const OVERLAY_DIR = path.join(__dirname, "..", "src", "overlay");

class FakeClassList {
  constructor(initial = "") {
    this.values = new Set(String(initial).split(/\s+/u).filter(Boolean));
  }

  add(...names) {
    for (const name of names) this.values.add(name);
  }

  remove(...names) {
    for (const name of names) this.values.delete(name);
  }

  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }

  contains(name) {
    return this.values.has(name);
  }

  toString() {
    return [...this.values].join(" ");
  }
}

class FakeElement {
  constructor(id = "", className = "") {
    this.id = id;
    this._className = className;
    this.classList = new FakeClassList(className);
    this.children = [];
    this.dataset = {};
    this.textContent = "";
    this.clientWidth = id === "caption-card" ? 620 : 568;
    this.listeners = new Map();
    const properties = new Map();
    this.style = {
      setProperty(name, value) {
        properties.set(name, String(value));
      },
      getPropertyValue(name) {
        return properties.get(name) || "";
      },
    };
  }

  set className(value) {
    this._className = String(value);
    this.classList = new FakeClassList(value);
  }

  get className() {
    return this._className;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  getBoundingClientRect() {
    return { width: this.clientWidth, height: 180, x: 0, y: 0 };
  }
}

function createHarness() {
  const callbacks = {};
  const reports = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  const classes = {
    "caption-card": "caption-card hidden",
    "final-lines": "final-lines",
    "partial-line": "translation partial hidden",
    "source-line": "source hidden",
    "draft-badge": "badge hidden",
    "overflow-badge": "badge overflow-badge hidden",
    "edit-toolbar": "edit-toolbar hidden",
    "safe-guide": "safe-guide hidden",
    "final-announcer": "sr-only",
  };
  const ids = [
    "status",
    "status-text",
    "caption-card",
    "final-lines",
    "partial-line",
    "source-line",
    "draft-badge",
    "overflow-badge",
    "latency",
    "edit-toolbar",
    "safe-guide",
    "final-announcer",
    "lock-overlay",
    "open-settings",
    "preset-bottom",
    "preset-top",
  ];
  const elements = Object.fromEntries(
    ids.map((id) => [id, new FakeElement(id, classes[id] || "")]),
  );
  const root = new FakeElement("root");
  const body = new FakeElement("body");
  const context2d = {
    font: "",
    measureText(value) {
      return { width: Array.from(String(value)).length * 10 };
    },
  };
  const document = {
    body,
    documentElement: root,
    getElementById(id) {
      return elements[id];
    },
    createElement(tagName) {
      if (tagName === "canvas") {
        return { getContext: () => context2d };
      }
      return new FakeElement();
    },
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    },
  };
  const audioTranslate = {
    onCaption(callback) {
      callbacks.caption = callback;
    },
    onStatus(callback) {
      callbacks.status = callback;
    },
    onInteraction(callback) {
      callbacks.interaction = callback;
    },
    onPreferences(callback) {
      callbacks.preferences = callback;
    },
    reportRendered(report) {
      reports.push(report);
    },
    setLocked() {},
    openControlCenter() {},
    applyPreset() {},
    nudge() {},
  };
  const window = {
    audioTranslate,
    innerWidth: 720,
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
  };
  let reflowCount = 0;
  const sandbox = {
    console,
    Date,
    Intl,
    Object,
    Array,
    String,
    Number,
    Math,
    RegExp,
    Set,
    Map,
    document,
    window,
    setTimeout() {
      return { unref() {} };
    },
    clearTimeout() {},
    requestAnimationFrame(callback) {
      callback(Date.now());
      return 1;
    },
    getComputedStyle(element) {
      return {
        font: "700 36px Inter",
        fontFamily: "Inter",
        fontSize: "36px",
        fontStyle: "normal",
        fontVariant: "normal",
        fontWeight: "700",
        lineHeight: "44px",
        paddingLeft: element === elements["caption-card"] ? "26px" : "0px",
        paddingRight: element === elements["caption-card"] ? "26px" : "0px",
      };
    },
    AudioTranslateOverlayKeyboard: { commandForOverlayKey: () => null },
  };
  sandbox.globalThis = sandbox;

  for (const file of ["caption-composer.js", "live-caption-block.js"]) {
    vm.runInNewContext(fs.readFileSync(path.join(OVERLAY_DIR, file), "utf8"), sandbox, {
      filename: file,
    });
  }
  const realLiveCaptionApi = sandbox.AudioTranslateLiveCaptionBlock;
  sandbox.AudioTranslateLiveCaptionBlock = {
    ...realLiveCaptionApi,
    createLiveCaptionBlock(options) {
      const block = realLiveCaptionApi.createLiveCaptionBlock(options);
      return {
        ...block,
        reflow(...args) {
          reflowCount += 1;
          return block.reflow(...args);
        },
      };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(OVERLAY_DIR, "renderer.js"), "utf8"), sandbox, {
    filename: "renderer.js",
  });

  return {
    callbacks,
    elements,
    reports,
    windowListeners,
    get reflowCount() {
      return reflowCount;
    },
  };
}

function caption(sequence, translation, isFinal, emittedAt, overrides = {}) {
  return {
    type: "caption",
    sessionId: "renderer-session",
    generation: 4,
    sequence,
    translation,
    transcript: "Original source text",
    isFinal,
    emittedAt,
    ...overrides,
  };
}

test("renderer keeps one stable translated node and appends a close utterance", () => {
  const harness = createHarness();
  harness.callbacks.preferences({
    showSource: false,
    maxTranslationLines: 2,
    captionResetGapMs: 1100,
  });
  const translatedNode = harness.elements["partial-line"];

  harness.callbacks.caption(caption(0, "Xin", false, 1000));
  assert.equal(translatedNode.textContent, "Xin");
  harness.callbacks.caption(caption(1, "Xin chào", false, 1020));
  assert.equal(harness.elements["partial-line"], translatedNode);
  assert.equal(translatedNode.textContent, "Xin chào");

  harness.callbacks.caption(caption(2, "Xin chào", true, 1050));
  harness.callbacks.caption(caption(3, "Bạn khỏe không?", false, 1700));
  assert.equal(translatedNode.textContent, "Xin chào Bạn khỏe không?");

  const visibleTranslations = [
    translatedNode,
    ...harness.elements["final-lines"].children,
  ].filter((element) => element.textContent && !element.classList.contains("hidden"));
  assert.equal(visibleTranslations.length, 1);
  assert.equal(harness.elements["source-line"].textContent, "");
  assert.equal(harness.elements["source-line"].classList.contains("hidden"), true);
});

test("renderer reflows live semantic text after width and font changes", () => {
  const harness = createHarness();
  harness.callbacks.preferences({ showSource: false, translationFontSize: 36 });
  harness.callbacks.caption(
    caption(
      0,
      "Một câu phụ đề đủ dài để đổi cách xuống dòng khi kích thước cửa sổ thay đổi.",
      false,
      1000,
    ),
  );
  const beforeResize = harness.reflowCount;

  harness.elements["caption-card"].clientWidth = 260;
  harness.windowListeners.get("resize")();
  assert.ok(harness.reflowCount > beforeResize);
  assert.ok(harness.elements["partial-line"].textContent.split("\n").length <= 2);

  const beforeFont = harness.reflowCount;
  harness.callbacks.preferences({ translationFontSize: 44 });
  assert.ok(harness.reflowCount > beforeFont);
});

test("renderer reports privacy-safe frame timing without caption content", () => {
  const harness = createHarness();
  harness.callbacks.preferences({ showSource: false });
  harness.callbacks.caption(caption(7, "Nội dung tuyệt mật không được ghi log", false, 1000));

  const report = harness.reports.at(-1);
  assert.equal(report.sessionId, "renderer-session");
  assert.equal(report.sequence, 7);
  assert.equal(report.isFinal, false);
  assert.equal(Number.isFinite(report.rafAt), true);
  assert.equal(Number.isFinite(report.resultToRafMs), true);
  const serialized = JSON.stringify(report).toLowerCase();
  assert.doesNotMatch(serialized, /nội dung|translation|transcript|caption|text|audio|bytes|data/u);
});
