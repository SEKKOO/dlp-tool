#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_BASE_URL = 'https://spa.console.eagleyun.cn';
const DEFAULT_TARGET_PATH = '/overview/default';

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.EAGLEYUN_URL || DEFAULT_BASE_URL,
    username: process.env.EAGLEYUN_USERNAME || '',
    password: process.env.EAGLEYUN_PASSWORD || '',
    accountMaster: process.env.EAGLEYUN_ACCOUNT_MASTER || '1',
    corpCode: process.env.EAGLEYUN_CORP_CODE || '',
    redirect: process.env.EAGLEYUN_REDIRECT || '',
    targetPath: process.env.EAGLEYUN_TARGET_PATH || DEFAULT_TARGET_PATH,
    sessionDir: process.env.EAGLEYUN_SESSION_DIR || '.session',
    probeUrl: process.env.EAGLEYUN_PROBE_URL || '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    i += 1;
    switch (key) {
      case 'base-url':
        args.baseUrl = value;
        break;
      case 'username':
        args.username = value;
        break;
      case 'password':
        args.password = value;
        break;
      case 'account-master':
        args.accountMaster = value;
        break;
      case 'corp-code':
        args.corpCode = value;
        break;
      case 'redirect':
        args.redirect = value;
        break;
      case 'target-path':
        args.targetPath = value;
        break;
      case 'session-dir':
        args.sessionDir = value;
        break;
      case 'probe-url':
        args.probeUrl = value;
        break;
      default:
        throw new Error(`Unknown flag: --${key}`);
    }
  }

  return args;
}

function ensureArgs(args) {
  if (!args.username) {
    throw new Error('Missing username. Set EAGLEYUN_USERNAME or pass --username.');
  }
  if (!args.password) {
    throw new Error('Missing password. Set EAGLEYUN_PASSWORD or pass --password.');
  }
  if (args.accountMaster === '0' && !args.corpCode) {
    throw new Error('Sub-account login requires --corp-code or EAGLEYUN_CORP_CODE.');
  }
}

function extractPublicKey(html) {
  const match = html.match(/PUBLIC_KEY:\s*'([^']+)'/);
  if (!match) {
    throw new Error('PUBLIC_KEY not found in the login page HTML.');
  }
  return Buffer.from(match[1], 'base64').toString('utf8');
}

function encryptField(pem, value) {
  return crypto.publicEncrypt(
    {
      key: pem,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(value, 'utf8'),
  ).toString('base64');
}

function parseSetCookie(line) {
  const parts = line.split(';').map((item) => item.trim()).filter(Boolean);
  const [nameValue, ...attrs] = parts;
  const eqIndex = nameValue.indexOf('=');
  const cookie = {
    name: nameValue.slice(0, eqIndex),
    value: nameValue.slice(eqIndex + 1),
    domain: '',
    path: '/',
    secure: false,
    httpOnly: false,
    sameSite: '',
    expiresEpoch: 0,
  };

  for (const attr of attrs) {
    const [rawKey, ...rawValueParts] = attr.split('=');
    const key = rawKey.toLowerCase();
    const value = rawValueParts.join('=');
    if (key === 'domain') {
      cookie.domain = value;
    } else if (key === 'path') {
      cookie.path = value;
    } else if (key === 'max-age') {
      const seconds = Number.parseInt(value, 10);
      if (Number.isFinite(seconds) && seconds > 0) {
        cookie.expiresEpoch = Math.floor(Date.now() / 1000) + seconds;
      }
    } else if (key === 'expires') {
      const epoch = Math.floor(new Date(value).getTime() / 1000);
      if (Number.isFinite(epoch) && epoch > 0) {
        cookie.expiresEpoch = epoch;
      }
    } else if (key === 'secure') {
      cookie.secure = true;
    } else if (key === 'httponly') {
      cookie.httpOnly = true;
    } else if (key === 'samesite') {
      cookie.sameSite = value;
    }
  }

  return cookie;
}

function toNetscapeCookieLine(cookie) {
  const domain = cookie.domain || new URL(DEFAULT_BASE_URL).hostname;
  const includeSubdomains = domain.startsWith('.') || domain.split('.').length > 2 ? 'TRUE' : 'FALSE';
  const secure = cookie.secure ? 'TRUE' : 'FALSE';
  const expires = cookie.expiresEpoch || 0;
  return [domain, includeSubdomains, cookie.path || '/', secure, expires, cookie.name, cookie.value].join('\t');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureArgs(args);

  const baseUrl = args.baseUrl.replace(/\/$/, '');
  const normalizedTargetPath = args.targetPath.startsWith('/') ? args.targetPath : `/${args.targetPath}`;
  const loginPageUrl = `${baseUrl}/`;
  const loginApiUrl = new URL('/api/anon/usercenter/auth/login', baseUrl);
  if (args.redirect) {
    loginApiUrl.searchParams.set('redirect', args.redirect);
  }

  console.log(`Fetching ${loginPageUrl}`);
  const loginPageResp = await fetch(loginPageUrl);
  if (!loginPageResp.ok) {
    throw new Error(`Unable to fetch the login page: HTTP ${loginPageResp.status}`);
  }
  const publicKeyPem = extractPublicKey(await loginPageResp.text());

  const payload = {
    account_master: args.accountMaster,
    login_name: encryptField(publicKeyPem, args.username.trim()),
    password: encryptField(publicKeyPem, args.password),
  };
  if (args.accountMaster === '0') {
    payload.corp_code = args.corpCode;
  }

  console.log(`Posting login request to ${loginApiUrl}`);
  const loginResp = await fetch(loginApiUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      accept: 'application/json, text/plain, */*',
    },
    body: JSON.stringify(payload),
    redirect: 'manual',
  });

  const bodyText = await loginResp.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch (error) {
    throw new Error(`Login response was not JSON: ${bodyText.slice(0, 300)}`);
  }

  if (loginResp.status !== 200 || body.code !== 200) {
    throw new Error(`Login failed: HTTP ${loginResp.status}, body=${bodyText}`);
  }

  const loginData = body.data || {};
  if (loginData.need_mfa_login) {
    throw new Error('Login succeeded but MFA is required; this API helper stops before MFA verification.');
  }
  if (loginData.need_force_reset_pwd) {
    throw new Error('Login succeeded but the account must reset its password before continuing.');
  }

  const setCookies = typeof loginResp.headers.getSetCookie === 'function'
    ? loginResp.headers.getSetCookie()
    : (loginResp.headers.get('set-cookie') ? [loginResp.headers.get('set-cookie')] : []);

  const cookies = setCookies
    .map(parseSetCookie)
    .filter((cookie) => cookie.name && cookie.value);

  if (!cookies.length) {
    throw new Error('Login succeeded but no session cookies were returned.');
  }

  const sessionDir = path.resolve(args.sessionDir);
  ensureDir(sessionDir);
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const sessionJsonPath = path.join(sessionDir, 'session.json');
  const netscapePath = path.join(sessionDir, 'cookies.txt');
  const cookieHeaderPath = path.join(sessionDir, 'cookie-header.txt');
  const loginResponsePath = path.join(sessionDir, 'login-response.json');

  fs.writeFileSync(sessionJsonPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    baseUrl,
    redirectUrl: loginData.redirect_url || baseUrl,
    targetUrl: `${baseUrl}${normalizedTargetPath}`,
    cookies,
  }, null, 2), 'utf8');
  fs.writeFileSync(
    netscapePath,
    ['# Netscape HTTP Cookie File', ...cookies.map(toNetscapeCookieLine), ''].join('\n'),
    'utf8',
  );
  fs.writeFileSync(cookieHeaderPath, `${cookieHeader}\n`, 'utf8');
  fs.writeFileSync(loginResponsePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');

  console.log('Login succeeded.');
  console.log(`- redirect URL: ${loginData.redirect_url || baseUrl}`);
  console.log(`- target URL: ${baseUrl}${normalizedTargetPath}`);
  console.log(`- session JSON: ${sessionJsonPath}`);
  console.log(`- cookie jar: ${netscapePath}`);
  console.log(`- cookie header: ${cookieHeaderPath}`);
  console.log(`- raw login response: ${loginResponsePath}`);

  if (args.probeUrl) {
    console.log(`Probing ${args.probeUrl}`);
    const probeResp = await fetch(args.probeUrl, {
      headers: {
        cookie: cookieHeader,
      },
      redirect: 'manual',
    });
    const probeText = await probeResp.text();
    const probePath = path.join(sessionDir, 'probe.txt');
    fs.writeFileSync(probePath, probeText, 'utf8');
    console.log(`- probe status: ${probeResp.status}`);
    console.log(`- probe output: ${probePath}`);
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
