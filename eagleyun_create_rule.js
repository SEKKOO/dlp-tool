#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_BASE_URL = 'https://spa.console.eagleyun.cn';
const DEFAULT_TARGET_PATH = '/overview/default';
const DEFAULT_DLP_PREFIX = '/openApi/v1/dlp/spa_6aa11a23-3048-4218-8469-579d68cba5bb';
const KNOWN_SENSITIVE_TAGS = {
  '关键词': {
    ER图: {
      code: '2646593',
      name: 'ER图',
      type: 'system',
    },
  },
};

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.EAGLEYUN_URL || DEFAULT_BASE_URL,
    username: process.env.EAGLEYUN_USERNAME || '',
    password: process.env.EAGLEYUN_PASSWORD || '',
    accountMaster: process.env.EAGLEYUN_ACCOUNT_MASTER || '1',
    corpCode: process.env.EAGLEYUN_CORP_CODE || '',
    redirect: process.env.EAGLEYUN_REDIRECT || '',
    targetPath: process.env.EAGLEYUN_TARGET_PATH || DEFAULT_TARGET_PATH,
    dlpPrefix: process.env.EAGLEYUN_DLP_PREFIX || DEFAULT_DLP_PREFIX,
    configPath: process.env.RULE_CONFIG_FILE || path.join(process.cwd(), 'rule-config.json'),
    outputDir: process.env.OUTPUT_DIR || path.join('.session', 'create-rule-api'),
    sessionDir: process.env.EAGLEYUN_SESSION_DIR || path.join('.session', 'api-login'),
    dryRun: (process.env.DRY_RUN || '1') !== '0',
    csrfToken: process.env.EAGLEYUN_CSRF_TOKEN || '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--base-url':
        args.baseUrl = argv[++i];
        break;
      case '--username':
        args.username = argv[++i];
        break;
      case '--password':
        args.password = argv[++i];
        break;
      case '--account-master':
        args.accountMaster = argv[++i];
        break;
      case '--corp-code':
        args.corpCode = argv[++i];
        break;
      case '--redirect':
        args.redirect = argv[++i];
        break;
      case '--target-path':
        args.targetPath = argv[++i];
        break;
      case '--dlp-prefix':
        args.dlpPrefix = argv[++i];
        break;
      case '--config':
        args.configPath = argv[++i];
        break;
      case '--output-dir':
        args.outputDir = argv[++i];
        break;
      case '--session-dir':
        args.sessionDir = argv[++i];
        break;
      case '--csrf-token':
        args.csrfToken = argv[++i];
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--apply':
        args.dryRun = false;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
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
  if (!fs.existsSync(args.configPath)) {
    throw new Error(`Rule config file not found: ${args.configPath}`);
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeRuleConfigs(rawConfig) {
  let rules;
  if (Array.isArray(rawConfig)) {
    rules = rawConfig;
  } else if (rawConfig && typeof rawConfig === 'object' && Array.isArray(rawConfig.rules)) {
    rules = rawConfig.rules;
  } else if (rawConfig && typeof rawConfig === 'object') {
    rules = [rawConfig];
  } else {
    throw new Error('Rule config must be an object, an array of objects, or an object with a rules array.');
  }

  if (!rules.length) {
    throw new Error('Rule config does not contain any rules.');
  }

  return rules.map((rule, index) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error(`Rule at index ${index} must be an object.`);
    }
    if (!rule.name || typeof rule.name !== 'string') {
      throw new Error(`Rule at index ${index} is missing a valid name.`);
    }
    if (!rule.ruleType || typeof rule.ruleType !== 'string') {
      throw new Error(`Rule "${rule.name}" is missing a valid ruleType.`);
    }
    return rule;
  });
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

function cookieIdentity(cookie) {
  return [
    cookie.name || '',
    cookie.domain || '',
    cookie.path || '/',
  ].join('|');
}

function mergeCookies(existing, incoming) {
  const merged = new Map();
  for (const cookie of existing || []) {
    if (cookie && cookie.name) {
      merged.set(cookieIdentity(cookie), cookie);
    }
  }
  for (const cookie of incoming || []) {
    if (cookie && cookie.name) {
      merged.set(cookieIdentity(cookie), cookie);
    }
  }
  return Array.from(merged.values());
}

function buildCookieHeader(cookies) {
  return (cookies || [])
    .filter((cookie) => cookie && cookie.name && cookie.value)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function getSetCookies(headers) {
  return typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
}

function findCookieValue(cookies, name) {
  const match = (cookies || []).find((cookie) => cookie && cookie.name === name);
  return match ? match.value : '';
}

function decodeMaybe(value) {
  if (!value) {
    return '';
  }
  try {
    return decodeURIComponent(value);
  } catch (error) {
    return value;
  }
}

async function fetchWithCookies(url, options = {}) {
  const {
    cookies = [],
    headers = {},
    ...rest
  } = options;

  const nextHeaders = {
    ...headers,
  };
  const cookieHeader = buildCookieHeader(cookies);
  if (cookieHeader) {
    nextHeaders.cookie = cookieHeader;
  }

  const response = await fetch(url, {
    redirect: 'manual',
    ...rest,
    headers: nextHeaders,
  });

  const receivedCookies = getSetCookies(response.headers)
    .map(parseSetCookie)
    .filter((cookie) => cookie.name && cookie.value);

  return {
    response,
    cookies: mergeCookies(cookies, receivedCookies),
    receivedCookies,
  };
}

async function loginWithApi(args) {
  const baseUrl = args.baseUrl.replace(/\/$/, '');
  const loginPageUrl = `${baseUrl}/`;
  const loginApiUrl = new URL('/api/anon/usercenter/auth/login', baseUrl);
  if (args.redirect) {
    loginApiUrl.searchParams.set('redirect', args.redirect);
  }

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

  const cookies = getSetCookies(loginResp.headers)
    .map(parseSetCookie)
    .filter((cookie) => cookie.name && cookie.value);

  if (!cookies.length) {
    throw new Error('Login succeeded but no session cookies were returned.');
  }

  return {
    loginData,
    cookies,
    rawResponse: body,
  };
}

async function bootstrapSpaSession(baseUrl, cookies, csrfToken = '') {
  const attempts = [
    `${baseUrl}/overview/default`,
    `${baseUrl}/`,
    `${baseUrl}/dlp/data_identify/default`,
  ];
  let mergedCookies = mergeCookies([], cookies);
  let csrf = decodeMaybe(csrfToken || findCookieValue(mergedCookies, 'csrf'));
  const trace = [];

  for (const url of attempts) {
    const { response, cookies: nextCookies, receivedCookies } = await fetchWithCookies(url, {
      cookies: mergedCookies,
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    mergedCookies = nextCookies;
    const text = await response.text();
    if (!csrf) {
      csrf = decodeMaybe(findCookieValue(mergedCookies, 'csrf'));
    }
    if (!csrf) {
      csrf = decodeMaybe(response.headers.get('x-csrf-token') || response.headers.get('X-CSRF-TOKEN') || '');
    }
    if (!csrf) {
      const match = text.match(/csrf["']?\s*[:=]\s*["']([^"']+)["']/i);
      if (match) {
        csrf = decodeMaybe(match[1]);
      }
    }
    trace.push({
      url,
      status: response.status,
      receivedCookieNames: receivedCookies.map((cookie) => cookie.name),
      hasCsrf: Boolean(csrf),
      bodySample: text.slice(0, 160),
    });
    if (csrf) {
      break;
    }
  }

  return {
    cookies: mergedCookies,
    csrfToken: csrf,
    trace,
  };
}

async function gatewayRequest(baseUrl, cookies, csrfToken, requestPath, method = 'GET', body = '') {
  const url = new URL('/console/v1/request', baseUrl);
  url.searchParams.set('path', requestPath.split('?')[0]);

  const requestBody = typeof body === 'string' ? body : JSON.stringify(body);
  const payload = {
    method: method.toUpperCase(),
    path: requestPath,
    body: requestBody,
  };

  const { response, cookies: nextCookies } = await fetchWithCookies(url.toString(), {
    method: 'POST',
    cookies,
    headers: {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'content-type': 'application/json;charset=UTF-8',
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      referer: `${baseUrl}/dlp/data_identify/default`,
    },
    body: JSON.stringify(payload),
  });

  const rawText = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`Gateway response was not JSON for ${requestPath}: ${rawText.slice(0, 500)}`);
  }

  if (!response.ok || parsed.code !== 200) {
    throw new Error(`Gateway request failed for ${requestPath}: HTTP ${response.status}, body=${rawText.slice(0, 800)}`);
  }

  return {
    data: parsed.data,
    raw: parsed,
    cookies: nextCookies,
    request: payload,
  };
}

function collectObjects(value, results = [], seen = new Set()) {
  if (!value || typeof value !== 'object') {
    return results;
  }
  if (seen.has(value)) {
    return results;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      collectObjects(item, results, seen);
    }
    return results;
  }
  results.push(value);
  for (const item of Object.values(value)) {
    collectObjects(item, results, seen);
  }
  return results;
}

function getFirstString(obj, keys) {
  for (const key of keys) {
    if (typeof obj[key] === 'string' && obj[key].trim()) {
      return obj[key].trim();
    }
  }
  return '';
}

function getFirstCode(obj, keys) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return '';
}

function findCategoryCode(rawData, ruleType) {
  const objects = collectObjects(rawData);
  const nameKeys = ['name', 'label', 'title', 'category_name', 'categoryName', 'text'];
  const codeKeys = ['code', 'category_code', 'categoryCode', 'id', 'value'];
  const match = objects.find((item) => {
    const name = getFirstString(item, nameKeys);
    const code = getFirstCode(item, codeKeys);
    return name === ruleType && code;
  });
  if (!match) {
    const samples = objects.slice(0, 20).map((item) => ({
      name: getFirstString(item, nameKeys),
      code: getFirstCode(item, codeKeys),
    }));
    throw new Error(`Unable to find rule type "${ruleType}" in category list. Samples: ${JSON.stringify(samples)}`);
  }
  return getFirstCode(match, codeKeys);
}

function findSensitiveTag(rawData, kind, name) {
  const objects = collectObjects(rawData);
  const nameKeys = ['name', 'label', 'title', 'tag_name', 'tagName', 'text'];
  const codeKeys = ['code', 'id', 'tag_code', 'tagCode', 'value'];
  const typeKeys = ['type', 'source_type', 'sourceType', 'tag_type', 'tagType'];
  const kindKeys = ['category_name', 'categoryName', 'group_name', 'groupName', 'parent_name', 'parentName', 'type_name', 'typeName'];

  const exactMatches = objects.filter((item) => {
    const itemName = getFirstString(item, nameKeys);
    const itemCode = getFirstCode(item, codeKeys);
    return itemName === name && itemCode;
  });

  if (!exactMatches.length) {
    const fallback = KNOWN_SENSITIVE_TAGS[kind] && KNOWN_SENSITIVE_TAGS[kind][name];
    if (fallback) {
      return {
        ...fallback,
        resolvedBy: 'known-map',
      };
    }
    const samples = objects.slice(0, 20).map((item) => ({
      name: getFirstString(item, nameKeys),
      code: getFirstCode(item, codeKeys),
      kind: getFirstString(item, kindKeys),
      type: getFirstString(item, typeKeys),
    }));
    throw new Error(`Unable to find sensitive tag "${name}". Samples: ${JSON.stringify(samples)}`);
  }

  const preferred = exactMatches.find((item) => {
    const itemKind = getFirstString(item, kindKeys);
    return !kind || itemKind.includes(kind);
  }) || exactMatches[0];

  return {
    code: getFirstCode(preferred, codeKeys),
    name: getFirstString(preferred, nameKeys) || name,
    type: getFirstString(preferred, typeKeys) || 'system',
    resolvedBy: 'api',
  };
}

function buildRulePayload(config, categoryCode, sensitiveTag) {
  const normalizedLevel = String(config.level || '').trim().toLowerCase();
  if (!/^s[1-4]$/.test(normalizedLevel)) {
    throw new Error(`Unsupported data level: ${config.level}`);
  }

  const fileContent = config.conditions && config.conditions.fileContent;
  const bodyMatch = fileContent && fileContent.bodyMatch;
  if (!fileContent || !fileContent.enabled) {
    throw new Error('Only fileContent.enabled=true is currently supported in the API script.');
  }
  if (!bodyMatch || bodyMatch.kind !== '关键词') {
    throw new Error('Only 文件正文匹配 -> 关键词 is currently supported in the API script.');
  }

  const matchOperator = bodyMatch.mode === '满足任一' ? 'or' : 'and';
  const payload = {
    name: config.name,
    category_code: categoryCode,
    code: normalizedLevel,
    conditionGroups: ['file_conditions'],
    enable: config.enable !== false,
    is_support_audit: !(config.usage && config.usage.audit === false),
    is_support_api: !(config.usage && config.usage.api === false),
    rule: {
      operator: 'and',
      conditions: [
        {
          locations: ['content'],
          operator: 'and',
          conditions: [
            {
              operator: matchOperator,
              conditions: [
                {
                  code: sensitiveTag.code,
                  type: sensitiveTag.type || 'system',
                  name: sensitiveTag.name,
                },
              ],
            },
          ],
        },
      ],
    },
    elements: 'file_conditions',
  };

  if (config.description) {
    payload.description = config.description;
  }
  if (Array.isArray(config.resourceGroupIds) && config.resourceGroupIds.length) {
    payload.resource_group_ids = config.resourceGroupIds;
  }

  return payload;
}

function resolveRuleContext(ruleConfig, categoriesData, tagsData) {
  const fileContent = ruleConfig.conditions && ruleConfig.conditions.fileContent;
  const bodyMatch = fileContent && fileContent.bodyMatch;
  const categoryCode = findCategoryCode(categoriesData, ruleConfig.ruleType);
  const sensitiveTag = findSensitiveTag(
    tagsData,
    bodyMatch && bodyMatch.kind,
    bodyMatch && bodyMatch.value,
  );
  const payload = buildRulePayload(ruleConfig, categoryCode, sensitiveTag);
  return {
    name: ruleConfig.name,
    ruleType: ruleConfig.ruleType,
    level: ruleConfig.level,
    categoryCode,
    sensitiveTag,
    payload,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureArgs(args);

  const baseUrl = args.baseUrl.replace(/\/$/, '');
  const outputDir = path.resolve(args.outputDir);
  const sessionDir = path.resolve(args.sessionDir);
  ensureDir(outputDir);
  ensureDir(sessionDir);

  const rawRuleConfig = loadJson(args.configPath);
  const ruleConfigs = normalizeRuleConfigs(rawRuleConfig);
  writeJson(path.join(outputDir, 'rule-config.snapshot.json'), rawRuleConfig);
  writeJson(path.join(outputDir, 'rule-config.normalized.json'), ruleConfigs);

  const loginResult = await loginWithApi(args);
  writeJson(path.join(sessionDir, 'login-response.json'), loginResult.rawResponse);
  writeJson(path.join(sessionDir, 'session.json'), {
    createdAt: new Date().toISOString(),
    baseUrl,
    cookies: loginResult.cookies,
  });
  fs.writeFileSync(path.join(sessionDir, 'cookie-header.txt'), `${buildCookieHeader(loginResult.cookies)}\n`, 'utf8');

  const bootstrap = await bootstrapSpaSession(baseUrl, loginResult.cookies, args.csrfToken);
  writeJson(path.join(sessionDir, 'bootstrap-trace.json'), bootstrap.trace);
  writeJson(path.join(sessionDir, 'bootstrap-session.json'), {
    csrfToken: bootstrap.csrfToken,
    cookies: bootstrap.cookies,
  });

  if (!bootstrap.csrfToken) {
    throw new Error('Unable to discover csrf token from the SPA bootstrap. You can pass it explicitly with --csrf-token or EAGLEYUN_CSRF_TOKEN.');
  }

  let workingCookies = bootstrap.cookies;

  const categories = await gatewayRequest(
    baseUrl,
    workingCookies,
    bootstrap.csrfToken,
    `${args.dlpPrefix}/filesecurity/list_categories`,
    'GET',
    '',
  );
  workingCookies = categories.cookies;
  writeJson(path.join(outputDir, 'categories.raw.json'), categories.raw);

  const tags = await gatewayRequest(
    baseUrl,
    workingCookies,
    bootstrap.csrfToken,
    `${args.dlpPrefix}/sensitivedata/tags`,
    'GET',
    '',
  );
  workingCookies = tags.cookies;
  writeJson(path.join(outputDir, 'tags.raw.json'), tags.raw);

  const resolvedRules = ruleConfigs.map((ruleConfig, index) => ({
    index,
    ...resolveRuleContext(ruleConfig, categories.data, tags.data),
  }));

  const batchPayloadsPath = path.join(outputDir, args.dryRun ? 'batch-payloads.dry-run.json' : 'batch-payloads.json');
  const batchResolvedPath = path.join(outputDir, 'batch-resolved-values.json');

  writeJson(batchPayloadsPath, resolvedRules.map((item) => ({
    index: item.index,
    name: item.name,
    payload: item.payload,
  })));
  writeJson(batchResolvedPath, {
    csrfToken: bootstrap.csrfToken,
    rules: resolvedRules.map((item) => ({
      index: item.index,
      name: item.name,
      ruleType: item.ruleType,
      level: item.level,
      categoryCode: item.categoryCode,
      sensitiveTag: item.sensitiveTag,
    })),
  });

  if (resolvedRules.length === 1) {
    writeJson(
      path.join(outputDir, args.dryRun ? 'create-payload.dry-run.json' : 'create-payload.json'),
      resolvedRules[0].payload,
    );
    writeJson(path.join(outputDir, 'resolved-values.json'), {
      categoryCode: resolvedRules[0].categoryCode,
      sensitiveTag: resolvedRules[0].sensitiveTag,
      csrfToken: bootstrap.csrfToken,
    });
  }

  if (args.dryRun) {
    console.log('Dry run ready.');
    console.log(`- rule config: ${args.configPath}`);
    console.log(`- rules: ${resolvedRules.length}`);
    console.log(`- payloads: ${batchPayloadsPath}`);
    console.log(`- resolved values: ${batchResolvedPath}`);
    console.log(`- categories raw: ${path.join(outputDir, 'categories.raw.json')}`);
    console.log(`- tags raw: ${path.join(outputDir, 'tags.raw.json')}`);
    return;
  }

  const batchResults = [];
  for (const item of resolvedRules) {
    try {
      const createResult = await gatewayRequest(
        baseUrl,
        workingCookies,
        bootstrap.csrfToken,
        `${args.dlpPrefix}/filesecurity/`,
        'POST',
        item.payload,
      );
      workingCookies = createResult.cookies;
      batchResults.push({
        index: item.index,
        name: item.name,
        ok: true,
        request: createResult.request,
        response: createResult.raw,
      });
    } catch (error) {
      batchResults.push({
        index: item.index,
        name: item.name,
        ok: false,
        error: error.message,
      });
    }
  }

  const batchResultsPath = path.join(outputDir, 'batch-results.json');
  writeJson(batchResultsPath, batchResults);

  if (resolvedRules.length === 1 && batchResults[0] && batchResults[0].ok) {
    writeJson(path.join(outputDir, 'create-request.raw.json'), batchResults[0].request);
    writeJson(path.join(outputDir, 'create-response.json'), batchResults[0].response);
  }

  const successCount = batchResults.filter((item) => item.ok).length;
  const failed = batchResults.filter((item) => !item.ok);

  console.log('Rule create requests finished via API.');
  console.log(`- total rules: ${resolvedRules.length}`);
  console.log(`- succeeded: ${successCount}`);
  console.log(`- failed: ${failed.length}`);
  console.log(`- results: ${batchResultsPath}`);
  console.log(`- payloads: ${batchPayloadsPath}`);

  if (failed.length) {
    for (const item of failed) {
      console.error(`FAILED [${item.index}] ${item.name}: ${item.error}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
