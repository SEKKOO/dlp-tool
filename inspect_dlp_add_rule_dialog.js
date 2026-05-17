#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CHROME_BIN = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9222);
const LOGIN_ENTRY_URL = process.env.LOGIN_ENTRY_URL || 'https://spa.console.eagleyun.cn/';
const TARGET_URL = process.env.TARGET_URL || 'https://spa.console.eagleyun.cn/dlp/data_identify/default';
const POST_LOGIN_URL = process.env.POST_LOGIN_URL || 'https://spa.console.eagleyun.cn/overview/default';
const SESSION_FILE = process.env.SESSION_FILE || path.join('.session', 'session.json');
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join('.session', 'add-rule-dialog');
const PROFILE_DIR = process.env.CHROME_PROFILE_DIR || path.join('.chrome-profile', `add-rule-dialog-${Date.now()}`);
const USERNAME = process.env.EAGLEYUN_USERNAME || '';
const PASSWORD = process.env.EAGLEYUN_PASSWORD || '';
const USE_SESSION_COOKIES = (process.env.USE_SESSION_COOKIES || '1') !== '0';
const HEADLESS = (process.env.EAGLEYUN_HEADLESS || '0') === '1';

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, fn, timeoutMs = 60000, intervalMs = 500) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await fn();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function normalizeSameSite(value) {
  if (!value) return 'Lax';
  const lower = String(value).toLowerCase();
  if (lower === 'strict') return 'Strict';
  if (lower === 'none') return 'None';
  return 'Lax';
}

function loadCookies() {
  if (!USE_SESSION_COOKIES || !fs.existsSync(SESSION_FILE)) {
    return [];
  }
  const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  return (session.cookies || []).map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain || '.eagleyun.cn',
    path: cookie.path || '/',
    expires: cookie.expiresEpoch || undefined,
    httpOnly: !!cookie.httpOnly,
    secure: cookie.secure !== false,
    sameSite: normalizeSameSite(cookie.sameSite),
  }));
}

function launchChrome() {
  ensureDir(PROFILE_DIR);
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${path.resolve(PROFILE_DIR)}`,
    '--window-size=1600,1200',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ];
  if (HEADLESS) {
    args.splice(3, 0, '--headless=new', '--disable-gpu', '--hide-scrollbars');
  }

  return spawn(CHROME_BIN, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Set();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        this.ws.removeEventListener('open', onOpen);
        this.ws.removeEventListener('error', onError);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (event) => {
        cleanup();
        reject(event.error || new Error('Unable to connect to Chrome DevTools'));
      };
      this.ws.addEventListener('open', onOpen);
      this.ws.addEventListener('error', onError);
    });

    this.ws.addEventListener('message', (event) => {
      const payload = JSON.parse(event.data);
      if (payload.id) {
        const pending = this.pending.get(payload.id);
        if (!pending) return;
        this.pending.delete(payload.id);
        if (payload.error) {
          pending.reject(new Error(payload.error.message || JSON.stringify(payload.error)));
        } else {
          pending.resolve(payload.result);
        }
        return;
      }
      for (const handler of this.eventHandlers) {
        handler(payload);
      }
    });

    this.ws.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error('Chrome DevTools connection closed'));
      }
      this.pending.clear();
    });
  }

  onEvent(handler) {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  async send(method, params = {}, sessionId) {
    const id = this.nextId += 1;
    const message = { id, method, params };
    if (sessionId) {
      message.sessionId = sessionId;
    }
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify(message));
    return promise;
  }

  async close() {
    if (!this.ws) return;
    this.ws.close();
    await sleep(100);
  }
}

async function evalJson(client, sessionId, expression) {
  const result = await client.send(
    'Runtime.evaluate',
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
    },
    sessionId,
  );
  return result.result ? result.result.value : undefined;
}

function looksLikeLoginState(state) {
  if (!state || typeof state !== 'object') {
    return false;
  }
  if (String(state.url || '').includes('/login')) {
    return true;
  }
  if (String(state.title || '').includes('登录')) {
    return true;
  }
  return Array.isArray(state.visibleInputs)
    && state.visibleInputs.some((item) => String(item.type || '').toLowerCase() === 'password');
}

function isCorpCodeLoginState(state) {
  if (!state || typeof state !== 'object') {
    return false;
  }
  if (String(state.url || '').includes('/login/corp_code')) {
    return true;
  }
  return Array.isArray(state.visibleInputs)
    && state.visibleInputs.some((item) => String(item.placeholder || '').includes('企业标识码'));
}

function visiblePredicateSource() {
  return `
    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  `;
}

function clickPasswordLoginExpression() {
  return `(() => {
    ${visiblePredicateSource()}
    const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], .ant-tabs-tab, .ant-radio-button-wrapper, .ant-segmented-item'));
    const target = nodes.find((el) => {
      if (!isVisible(el)) return false;
      const text = textOf(el);
      return /密码登录/.test(text) || /^账号登录$/.test(text);
    });
    if (!target) {
      return { ok: false };
    }
    target.click();
    return { ok: true, text: textOf(target) };
  })()`;
}

function exitCorpCodeLoginExpression() {
  return `(() => {
    ${visiblePredicateSource()}
    const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], .ant-btn'));
    const target = nodes.find((el) => {
      if (!isVisible(el)) return false;
      const text = textOf(el);
      return /返回|主账号登录/.test(text);
    });
    if (!target) {
      return { ok: false };
    }
    target.click();
    return { ok: true, text: textOf(target) };
  })()`;
}

function fillAndClickLoginExpression(username, password) {
  return `(() => {
    const username = ${JSON.stringify(username)};
    const password = ${JSON.stringify(password)};
    ${visiblePredicateSource()}
    const attrText = (el) => [
      el.getAttribute('placeholder') || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('name') || '',
      el.getAttribute('id') || '',
      el.getAttribute('autocomplete') || '',
      el.className || '',
    ].join(' ').toLowerCase();
    const setNativeValue = (el, value) => {
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && typeof desc.set === 'function') {
        desc.set.call(el, value);
      } else {
        el.value = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Tab' }));
    };
    const scoreUsername = (el) => {
      if (!isVisible(el) || el.disabled || el.readOnly) return -999;
      if ((el.type || '').toLowerCase() === 'password') return -999;
      const text = attrText(el);
      let score = 0;
      if (/手机|手机号|电话|账号|用户名|user|account|mobile|phone/.test(text)) score += 20;
      if (/tel|text|email/.test((el.type || '').toLowerCase())) score += 8;
      if (/username/.test(text)) score += 12;
      const rect = el.getBoundingClientRect();
      score += Math.min(rect.width, 400) / 100;
      return score;
    };
    const scoreButton = (el) => {
      if (!isVisible(el) || el.disabled) return -999;
      const text = textOf(el);
      let score = 0;
      if (/登录|立即登录|登 录/.test(text)) score += 30;
      if ((el.className || '').toLowerCase().includes('primary')) score += 10;
      if (el.tagName === 'BUTTON') score += 5;
      return score;
    };

    const allInputs = Array.from(document.querySelectorAll('input'));
    const usernameInput = allInputs
      .map((el) => ({ el, score: scoreUsername(el) }))
      .sort((a, b) => b.score - a.score)[0];
    const passwordInput = allInputs.find((el) => isVisible(el) && !el.disabled && !el.readOnly && (el.type || '').toLowerCase() === 'password');
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, .ant-btn, input[type="button"], input[type="submit"]'));
    const loginButton = buttons
      .map((el) => ({ el, score: scoreButton(el) }))
      .sort((a, b) => b.score - a.score)[0];

    if (!usernameInput || usernameInput.score < 1) {
      return {
        ok: false,
        reason: 'username_input_not_found',
        inputs: allInputs.map((el) => ({
          type: el.type,
          placeholder: el.getAttribute('placeholder') || '',
          visible: isVisible(el),
        })),
      };
    }
    if (!passwordInput) {
      return {
        ok: false,
        reason: 'password_input_not_found',
        inputs: allInputs.map((el) => ({
          type: el.type,
          placeholder: el.getAttribute('placeholder') || '',
          visible: isVisible(el),
        })),
      };
    }
    if (!loginButton || loginButton.score < 1) {
      return {
        ok: false,
        reason: 'login_button_not_found',
        buttons: buttons.map((el) => ({
          text: textOf(el),
          visible: isVisible(el),
          className: el.className || '',
        })),
      };
    }

    usernameInput.el.focus();
    setNativeValue(usernameInput.el, username);
    passwordInput.focus();
    setNativeValue(passwordInput, password);
    loginButton.el.click();

    return {
      ok: true,
      usernamePlaceholder: usernameInput.el.getAttribute('placeholder') || '',
      passwordPlaceholder: passwordInput.getAttribute('placeholder') || '',
      loginButtonText: textOf(loginButton.el),
    };
  })()`;
}

function clickAddRuleExpression() {
  return `(() => {
    ${visiblePredicateSource()}
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], .ant-btn'))
      .filter(isVisible)
      .map((el) => ({ el, text: textOf(el) }))
      .filter((item) => item.text.includes('添加规则'));
    if (!candidates.length) {
      return {
        ok: false,
        visibleButtons: Array.from(document.querySelectorAll('button, [role="button"], .ant-btn'))
          .filter(isVisible)
          .map((el) => textOf(el))
          .filter(Boolean)
          .slice(0, 80),
      };
    }
    const target = candidates[0].el;
    target.click();
    return { ok: true, text: candidates[0].text };
  })()`;
}

function dialogInfoExpression() {
  return `(() => {
    ${visiblePredicateSource()}
    const uniq = (items) => [...new Set(items.filter(Boolean))];
    const containers = Array.from(document.querySelectorAll('.ant-modal, .ant-drawer, .ant-popover, [role="dialog"]'))
      .filter(isVisible)
      .filter((el) => textOf(el));
    const roots = containers.length ? containers : [];
    return roots.map((root, index) => {
      const labels = uniq(Array.from(root.querySelectorAll('label, .ant-form-item-label, .ant-radio-wrapper, .ant-checkbox-wrapper, .ant-form-item-explain, .ant-select-item-option-content'))
        .filter(isVisible)
        .map((el) => textOf(el)));
      const fields = Array.from(root.querySelectorAll('input, textarea, select, [role="combobox"], .ant-select-selector, .ant-picker, .ant-input-number'))
        .filter(isVisible)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || '',
          name: el.getAttribute('name') || '',
          placeholder: el.getAttribute('placeholder') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          text: textOf(el),
          className: (el.className || '').toString(),
        }));
      const buttons = uniq(Array.from(root.querySelectorAll('button, [role="button"], .ant-btn'))
        .filter(isVisible)
        .map((el) => textOf(el)));
      return {
        index,
        title: textOf(root.querySelector('.ant-modal-title, .ant-drawer-title, .ant-popover-title, h1, h2, h3')),
        className: root.className,
        text: textOf(root).slice(0, 5000),
        labels,
        fields,
        buttons,
        html: root.outerHTML.slice(0, 30000),
      };
    });
  })()`;
}

function pageStateExpression() {
  return `(() => {
    ${visiblePredicateSource()}
    const visibleButtons = Array.from(document.querySelectorAll('button, [role="button"], a, .ant-btn'))
      .filter(isVisible)
      .map((el) => textOf(el))
      .filter(Boolean)
      .slice(0, 120);
    const visibleInputs = Array.from(document.querySelectorAll('input'))
      .filter(isVisible)
      .map((el) => ({
        type: (el.type || '').toLowerCase(),
        placeholder: el.getAttribute('placeholder') || '',
        name: el.getAttribute('name') || '',
        autocomplete: el.getAttribute('autocomplete') || '',
      }));
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      visibleButtons,
      visibleInputs,
      bodyText: (document.body ? document.body.innerText : '').slice(0, 12000),
    };
  })()`;
}

function pageDebugExpression() {
  return `(() => {
    ${visiblePredicateSource()}
    const visibleButtons = Array.from(document.querySelectorAll('button, [role="button"], .ant-btn'))
      .filter(isVisible)
      .map((el) => textOf(el))
      .filter(Boolean)
      .slice(0, 120);
    const links = Array.from(document.querySelectorAll('a'))
      .filter(isVisible)
      .map((el) => textOf(el))
      .filter(Boolean)
      .slice(0, 80);
    return {
      url: location.href,
      title: document.title,
      visibleButtons,
      links,
      bodyText: (document.body ? document.body.innerText : '').slice(0, 10000),
    };
  })()`;
}

async function captureScreenshot(client, sessionId, outputPath) {
  const result = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId);
  fs.writeFileSync(outputPath, Buffer.from(result.data, 'base64'));
}

async function writePageDebug(client, sessionId, name) {
  const jsonPath = path.join(OUTPUT_DIR, `${name}.json`);
  const pngPath = path.join(OUTPUT_DIR, `${name}.png`);
  const debugState = await evalJson(client, sessionId, pageDebugExpression());
  fs.writeFileSync(jsonPath, JSON.stringify(debugState, null, 2), 'utf8');
  await captureScreenshot(client, sessionId, pngPath);
  return { jsonPath, pngPath, debugState };
}

async function waitForPageReady(client, sessionId, timeoutMs = 60000) {
  await waitFor('page ready', async () => {
    const state = await evalJson(client, sessionId, `(() => ({
      readyState: document.readyState,
      hasBody: !!document.body,
      title: document.title,
      bodyText: document.body ? document.body.innerText.slice(0, 200) : '',
    }))()`);
    if (!state || !state.hasBody) {
      return null;
    }
    if (state.readyState === 'interactive' || state.readyState === 'complete') {
      return state;
    }
    return state.title || String(state.bodyText || '').trim().length ? state : null;
  }, timeoutMs, 500);
}

async function navigateAndWait(client, sessionId, url, timeoutMs = 60000) {
  await client.send('Page.navigate', { url }, sessionId);
  await waitForPageReady(client, sessionId, timeoutMs);
}

async function waitForLoginSurface(client, sessionId, timeoutMs = 60000) {
  return waitFor('login form surface', async () => {
    const state = await evalJson(client, sessionId, pageStateExpression());
    if (!state || !looksLikeLoginState(state)) {
      return state || null;
    }
    const hasInputs = Array.isArray(state.visibleInputs) && state.visibleInputs.length > 0;
    const hasButtons = Array.isArray(state.visibleButtons) && state.visibleButtons.length > 0;
    const hasBodyText = String(state.bodyText || '').trim().length > 20;
    return hasInputs || hasButtons || hasBodyText ? state : null;
  }, timeoutMs, 500);
}

async function switchToPrimaryAccountLogin(client, sessionId, state) {
  const currentUrl = new URL(String((state && state.url) || 'https://console.eagleyun.cn/login'));
  const redirect = currentUrl.searchParams.get('redirect') || TARGET_URL;
  await evalJson(client, sessionId, exitCorpCodeLoginExpression());
  let nextState = await waitForLoginSurface(client, sessionId, 10000);
  if (!isCorpCodeLoginState(nextState)) {
    return nextState;
  }
  const primaryLoginUrl = `https://console.eagleyun.cn/login?account_master=1&redirect=${encodeURIComponent(redirect)}`;
  await navigateAndWait(client, sessionId, primaryLoginUrl, 90000);
  nextState = await waitForLoginSurface(client, sessionId, 30000);
  if (!isCorpCodeLoginState(nextState)) {
    return nextState;
  }
  const spaLoginUrl = `https://spa.console.eagleyun.cn/?account_master=1&redirect=${encodeURIComponent(redirect)}`;
  await navigateAndWait(client, sessionId, spaLoginUrl, 90000);
  return waitForLoginSurface(client, sessionId, 30000);
}

async function ensureAuthenticated(client, sessionId) {
  let initialState = await waitForLoginSurface(client, sessionId, 30000);
  if (isCorpCodeLoginState(initialState)) {
    initialState = await switchToPrimaryAccountLogin(client, sessionId, initialState);
  }
  if (!looksLikeLoginState(initialState)) {
    return { usedLogin: false, state: initialState };
  }

  if (!USERNAME || !PASSWORD) {
    throw new Error('The browser landed on a login page, but EAGLEYUN_USERNAME / EAGLEYUN_PASSWORD are not set.');
  }

  if (!Array.isArray(initialState.visibleInputs)
    || !initialState.visibleInputs.some((item) => String(item.type || '').toLowerCase() === 'password')) {
    await evalJson(client, sessionId, clickPasswordLoginExpression());
    initialState = await waitForLoginSurface(client, sessionId, 30000);
  }

  const loginResult = await evalJson(client, sessionId, fillAndClickLoginExpression(USERNAME, PASSWORD));
  if (!loginResult || !loginResult.ok) {
    fs.writeFileSync(path.join(OUTPUT_DIR, 'login-fill-result.json'), JSON.stringify(loginResult, null, 2), 'utf8');
    await writePageDebug(client, sessionId, 'login-fill-failed');
    throw new Error(`Unable to fill or submit the login form: ${loginResult ? JSON.stringify(loginResult) : 'unknown error'}`);
  }

  const postLoginState = await waitFor('successful browser login', async () => {
    const state = await evalJson(client, sessionId, pageStateExpression());
    if (state && !looksLikeLoginState(state)) {
      return state;
    }
    return null;
  }, 120000, 1000);

  fs.writeFileSync(path.join(OUTPUT_DIR, 'post-login-state.json'), JSON.stringify({
    loginResult,
    postLoginState,
  }, null, 2), 'utf8');

  return { usedLogin: true, state: postLoginState, loginResult };
}

function parseGatewayRequest(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  if (!String(entry.url || '').includes('/console/v1/request')) {
    return null;
  }
  if (!entry.postData) {
    return null;
  }
  try {
    const outer = JSON.parse(entry.postData);
    const nestedBody = typeof outer.body === 'string'
      ? (() => {
        try {
          return JSON.parse(outer.body);
        } catch (error) {
          return outer.body;
        }
      })()
      : outer.body;
    return {
      method: outer.method || '',
      path: outer.path || '',
      body: nestedBody,
    };
  } catch (error) {
    return null;
  }
}

async function main() {
  ensureDir(OUTPUT_DIR);
  const chrome = launchChrome();
  let stderr = '';
  chrome.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const version = await waitFor('Chrome remote debugging', () => fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`), 30000, 500);
    const client = new CDPClient(version.webSocketDebuggerUrl);
    await client.connect();
    const networkLog = [];

    client.onEvent((event) => {
      if (event.method !== 'Network.requestWillBeSent') {
        return;
      }
      const request = event.params.request || {};
      networkLog.push({
        timestamp: new Date().toISOString(),
        type: event.params.type || '',
        url: request.url || '',
        method: request.method || '',
        postData: request.postData || '',
        headers: request.headers || {},
        documentURL: event.params.documentURL || '',
        initiatorType: (event.params.initiator && event.params.initiator.type) || '',
      });
    });

    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const attached = await client.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attached.sessionId;

    await client.send('Page.enable', {}, sessionId);
    await client.send('Runtime.enable', {}, sessionId);
    await client.send('DOM.enable', {}, sessionId);
    await client.send('Network.enable', { maxPostDataSize: 1024 * 1024 }, sessionId);
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: 1200,
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId);
    await client.send('Emulation.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
      platform: 'MacIntel',
    }, sessionId);
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] });
        Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4] });
        window.chrome = window.chrome || { runtime: {} };
      `,
    }, sessionId);

    const cookies = loadCookies();
    if (cookies.length) {
      await client.send('Network.setCookies', { cookies }, sessionId);
    }

    await navigateAndWait(client, sessionId, LOGIN_ENTRY_URL, 90000);
    const authState = await ensureAuthenticated(client, sessionId);

    const currentState = authState && authState.state
      ? authState.state
      : await evalJson(client, sessionId, pageStateExpression());

    if (!String((currentState && currentState.url) || '').includes('/overview/default')) {
      await navigateAndWait(client, sessionId, POST_LOGIN_URL, 90000);
    }
    let overviewState;
    try {
      overviewState = await waitFor('overview page after login', async () => {
        const state = await evalJson(client, sessionId, pageStateExpression());
        if (!state || looksLikeLoginState(state)) {
          return null;
        }
        return String(state.url || '').includes('/overview/default')
          && String(state.bodyText || '').trim().length > 20
          ? state
          : null;
      }, 120000, 1000);
    } catch (error) {
      await writePageDebug(client, sessionId, 'overview-timeout');
      throw error;
    }
    fs.writeFileSync(path.join(OUTPUT_DIR, 'overview-state.json'), JSON.stringify(overviewState, null, 2), 'utf8');

    await navigateAndWait(client, sessionId, TARGET_URL, 90000);

    try {
      await waitFor('DLP page with 添加规则 button', async () => {
        const state = await evalJson(client, sessionId, pageStateExpression());
        if (!state || looksLikeLoginState(state)) {
          return null;
        }
        const hasAddRule = Array.isArray(state.visibleButtons)
          && state.visibleButtons.some((text) => String(text).includes('添加规则'));
        return hasAddRule ? state : null;
      }, 120000, 1000);
    } catch (error) {
      await writePageDebug(client, sessionId, 'dlp-timeout');
      throw error;
    }

    fs.writeFileSync(path.join(OUTPUT_DIR, 'dlp-page-state.json'), JSON.stringify(
      await evalJson(client, sessionId, pageStateExpression()),
      null,
      2,
    ), 'utf8');

    const requestStartIndex = networkLog.length;

    let addRuleResult;
    try {
      addRuleResult = await waitFor('添加规则 button', async () => {
        const result = await evalJson(client, sessionId, clickAddRuleExpression());
        return result && result.ok ? result : null;
      }, 90000, 1000);
    } catch (error) {
      await writePageDebug(client, sessionId, 'page-debug');
      throw error;
    }

    const dialogInfo = await waitFor('add rule dialog', async () => {
      const result = await evalJson(client, sessionId, dialogInfoExpression());
      return Array.isArray(result) && result.length ? result : null;
    }, 30000, 500);

    const jsonPath = path.join(OUTPUT_DIR, 'dialog.json');
    const textPath = path.join(OUTPUT_DIR, 'dialog.txt');
    const screenshotPath = path.join(OUTPUT_DIR, 'dialog.png');
    const requestPath = path.join(OUTPUT_DIR, 'dialog-requests.json');

    const dialogRequests = networkLog.slice(requestStartIndex).map((entry) => ({
      ...entry,
      gateway: parseGatewayRequest(entry),
    }));

    fs.writeFileSync(jsonPath, JSON.stringify({
      targetUrl: TARGET_URL,
      clickedButton: addRuleResult,
      dialogs: dialogInfo,
    }, null, 2), 'utf8');

    const textOutput = dialogInfo.map((dialog, index) => [
      `Dialog #${index + 1}`,
      `Title: ${dialog.title || '(none)'}`,
      `Buttons: ${dialog.buttons.join(' | ')}`,
      `Labels: ${dialog.labels.join(' | ')}`,
      'Fields:',
      ...dialog.fields.map((field) => `- tag=${field.tag} type=${field.type} name=${field.name} placeholder=${field.placeholder} ariaLabel=${field.ariaLabel} text=${field.text}`),
      'Text:',
      dialog.text,
      '',
    ].join('\n')).join('\n====================\n\n');
    fs.writeFileSync(textPath, textOutput, 'utf8');
    fs.writeFileSync(requestPath, JSON.stringify(dialogRequests, null, 2), 'utf8');

    await captureScreenshot(client, sessionId, screenshotPath);

    console.log(`Clicked: ${addRuleResult.text}`);
    console.log(`Dialog JSON: ${jsonPath}`);
    console.log(`Dialog text: ${textPath}`);
    console.log(`Dialog screenshot: ${screenshotPath}`);
    console.log(`Dialog requests: ${requestPath}`);

    await client.send('Target.closeTarget', { targetId });
    await client.close();
  } finally {
    chrome.kill('SIGTERM');
    await sleep(500);
    if (chrome.exitCode === null) {
      chrome.kill('SIGKILL');
    }
    if (stderr.trim()) {
      fs.writeFileSync(path.join(OUTPUT_DIR, 'chrome-stderr.log'), stderr, 'utf8');
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
