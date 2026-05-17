# Eagleyun DLP 规则自动化工具

这套脚本围绕鹰云控制台的 DLP 数据识别规则做自动化，覆盖了：

- 纯 API 登录与规则创建
- Excel 模版批量导入
- 浏览器模式兜底创建
- 登录态导出、页面检查、弹窗排障

当前仓库的主思路是：

1. 能走 API 的场景优先走 API，便于批量化、可审计、可复跑
2. 遇到敏感标签值只能在前端页面搜索命中的场景，再回退到浏览器模式
3. Excel 导入作为日常维护入口，默认直接走浏览器模式，必要时可切到 `auto` 或 `api`

仓库内脚本基本只依赖 Node.js / Python 标准能力，不需要额外安装 npm 或 pip 包；但浏览器相关脚本需要本机可用的 Chrome，Safari 登录脚本需要 macOS 自带的 `safaridriver`。

## 功能概览

| 脚本 | 作用 | 当前定位 |
| --- | --- | --- |
| `eagleyun_create_rule.js` | 纯 API 创建规则，支持单条和批量 JSON | 主创建脚本 |
| `eagleyun_import_rules_excel.py` | 读取 Excel，转 JSON，并调用 API / 浏览器导入 | 主批量导入入口 |
| `eagleyun_create_rule_browser.js` | 通过 Chrome DevTools 打开“添加规则”弹窗并自动填写 | 浏览器兜底脚本 |
| `eagleyun_login_api.js` | 纯 API 登录，导出 cookie / session / probe 结果 | 登录与调试辅助 |
| `eagleyun_login.py` | 通过 Safari WebDriver 检查登录是否可达 | Safari 登录辅助 |
| `eagleyun_login_chrome.py` | 通过 Chrome + AppleScript 检查登录流程 | Chrome 登录辅助 |
| `inspect_dlp_add_rule_dialog.js` | 抓取“添加规则”弹窗结构、字段、请求日志 | 页面排障辅助 |

## 当前支持范围

### API 主链路当前正式覆盖

- 账号密码登录 `https://spa.console.eagleyun.cn`
- 自动抓取登录页 RSA 公钥并加密账号密码
- 自动 bootstrap SPA 会话并提取 `csrf`
- 通过 `POST /console/v1/request?path=...` 代理调用 DLP OpenAPI
- 读取规则分类 `filesecurity/list_categories`
- 读取敏感标签 `sensitivedata/tags`
- 创建文件内容识别规则 `filesecurity/`
- 支持单条、数组、`rules` 包装三种 JSON 配置格式
- 支持 dry-run / apply 两种执行模式
- 支持 `resourceGroupIds` 字段

### Excel / 浏览器链路当前正式覆盖

- 从 `.xlsx` / `.xlsm` 模版读取规则
- 表头中英文别名映射
- 自动生成 JSON 快照
- `browser` / `auto` / `api` 三种导入引擎
- 浏览器模式下自动登录、进入 DLP 页面、打开“添加规则”弹窗并填写
- 浏览器模式下自动搜索并选择敏感词 / 标签值
- 批量执行时按规则逐条落盘结果，便于失败后定位

### 规则范围说明

当前仓库最稳定、已围绕其做了完整封装的规则组合是：

- 规则类型：例如 `通用类`
- 数据级别：脚本允许 `S1` ~ `S4`
- 文件内容识别：开启
- 文件正文匹配：`关键词`
- 匹配关系：`满足所有`、`满足任一`
- 规则用途：`audit`、`api`
- 开启识别：`enable = true/false`

其中：

- `eagleyun_create_rule.js` 和 `eagleyun_import_rules_excel.py` 当前都按“文件正文匹配 -> 关键词”建模
- `eagleyun_create_rule_browser.js` 会按页面文案去选项里操作，更适合“页面里能搜到，但接口没返回细粒度标签”的情况

## 运行要求

- Node.js：建议使用较新的版本，需支持全局 `fetch` / `WebSocket`
- Python：`python3`
- Chrome：使用浏览器导入或弹窗检查脚本时需要
- macOS：如果要使用 `eagleyun_login.py` 或 `eagleyun_login_chrome.py`

至少准备以下环境变量：

```bash
export EAGLEYUN_USERNAME='你的账号'
export EAGLEYUN_PASSWORD='你的密码'
```

常见可选变量：

```bash
export EAGLEYUN_URL='https://spa.console.eagleyun.cn'
export EAGLEYUN_ACCOUNT_MASTER='1'
export EAGLEYUN_CORP_CODE=''
export EAGLEYUN_REDIRECT=''
export EAGLEYUN_TARGET_PATH='/overview/default'
export EAGLEYUN_DLP_PREFIX='/openApi/v1/dlp/spa_6aa11a23-3048-4218-8469-579d68cba5bb'
```

## 怎么运行

下面这些命令默认都在当前目录执行，也就是先进入本仓库目录：

```bash
cd /path/to/dlp-tool
```

### 1. 运行主脚本：按 JSON 创建规则

先准备账号密码：

```bash
export EAGLEYUN_USERNAME='你的账号'
export EAGLEYUN_PASSWORD='你的密码'
```

然后直接执行主脚本：

```bash
# 先做 dry-run，检查 payload 和标签解析结果
node eagleyun_create_rule.js --config rule-config.batch.json --dry-run

# 确认没问题后真正创建
node eagleyun_create_rule.js --config rule-config.batch.json --apply
```

如果只想创建单条规则，也可以这样跑：

```bash
node eagleyun_create_rule.js --config rule-config.json --dry-run
node eagleyun_create_rule.js --config rule-config.json --apply
```

### 2. 运行 Excel 导入脚本

首次使用可以先生成 Excel 模版：

```bash
python3 eagleyun_import_rules_excel.py --init-template
```

然后把规则填进 `templates/rule-import-template.xlsx`，再执行：

```bash
# 只把 Excel 转成 JSON，不创建
python3 eagleyun_import_rules_excel.py --only-generate-json

# 默认浏览器模式，先做 dry-run
python3 eagleyun_import_rules_excel.py --dry-run

# 真正创建
python3 eagleyun_import_rules_excel.py --apply
```

如果你有自己的 Excel 文件：

```bash
python3 eagleyun_import_rules_excel.py --excel ./templates/my-rules.xlsx --apply
```

### 3. 单独运行浏览器兜底脚本

这个脚本适合接口拿不到细粒度敏感标签，但页面里能搜到对应值的情况：

```bash
# 默认 dry-run，只打开页面并自动填写，不点击保存
RULE_CONFIG_FILE=rule-config.json node eagleyun_create_rule_browser.js

# 真正点击保存
RULE_CONFIG_FILE=rule-config.json DRY_RUN=0 node eagleyun_create_rule_browser.js
```

### 4. 单独验证登录

如果你只是想确认账号能否登录，先跑登录辅助脚本：

```bash
# 纯 API 登录，导出 cookie / session
node eagleyun_login_api.js --session-dir .session --probe-url 'https://spa.console.eagleyun.cn/overview/default'

# Chrome 登录检查
python3 eagleyun_login_chrome.py --close-on-success

# Safari 登录检查
python3 eagleyun_login.py --close-on-success
```

### 5. 排查“添加规则”页面结构

如果怀疑平台页面结构变了，可以直接跑：

```bash
node inspect_dlp_add_rule_dialog.js
```

它会输出弹窗截图、字段信息和请求日志，便于定位页面选择器是否失效。

## 推荐工作流

### 1. 用 JSON 走纯 API 创建规则

最推荐的日常流程：

```bash
node eagleyun_create_rule.js --config rule-config.batch.json --dry-run
node eagleyun_create_rule.js --config rule-config.batch.json --apply
```

说明：

- `--dry-run`：只完成登录、分类解析、标签解析、payload 生成，不真正创建
- `--apply`：真正提交规则
- 这个脚本会自己完成登录与 `csrf` 获取，不需要预先执行 `eagleyun_login_api.js`

### 2. 用 Excel 做批量导入

首次使用可以先生成模板：

```bash
python3 eagleyun_import_rules_excel.py --init-template
```

默认模板路径：

```text
templates/rule-import-template.xlsx
```

常见命令：

```bash
# 只把 Excel 转成 JSON
python3 eagleyun_import_rules_excel.py --only-generate-json

# 默认浏览器模式 dry-run
python3 eagleyun_import_rules_excel.py --dry-run

# 从指定 Excel 真正创建规则
python3 eagleyun_import_rules_excel.py --excel ./templates/my-rules.xlsx --apply

# API 优先，标签解析失败时自动回退到浏览器
python3 eagleyun_import_rules_excel.py --engine auto --apply

# 仅允许 API，不做浏览器回退
python3 eagleyun_import_rules_excel.py --engine api --apply
```

引擎建议：

- `browser`：默认值，最稳；匹配值按 Excel 原样去页面里搜
- `auto`：先走 API；如果出现 `Unable to find sensitive tag`，自动切到浏览器
- `api`：只适合标签接口本身就能解析出目标敏感词编码的场景

### 3. 浏览器模式单独调试

如果你想直接验证浏览器填单逻辑，可以单独跑：

```bash
RULE_CONFIG_FILE=rule-config.json node eagleyun_create_rule_browser.js
```

默认是 dry-run。真正点击保存可用：

```bash
RULE_CONFIG_FILE=rule-config.json DRY_RUN=0 node eagleyun_create_rule_browser.js
```

如果已经通过 `eagleyun_login_api.js` 导出了 `.session/session.json`，浏览器脚本会优先复用这些 cookie。

### 4. 只验证登录态

纯 API 登录并导出 cookie：

```bash
node eagleyun_login_api.js --session-dir .session --probe-url 'https://spa.console.eagleyun.cn/overview/default'
```

Chrome 登录检查：

```bash
python3 eagleyun_login_chrome.py --close-on-success
```

Safari 登录检查：

```bash
python3 eagleyun_login.py --close-on-success
```

## 规则配置格式

`eagleyun_create_rule.js` 支持三种配置格式。

### 1. 单条对象

对应示例文件：`rule-config.json`

```json
{
  "name": "ai测试3",
  "ruleType": "通用类",
  "description": "",
  "level": "S2",
  "enable": true,
  "conditions": {
    "fileContent": {
      "enabled": true,
      "bodyMatch": {
        "mode": "满足所有",
        "kind": "关键词",
        "value": "ER图"
      }
    }
  },
  "usage": {
    "audit": true,
    "api": true
  }
}
```

### 2. 数组格式

```json
[
  {
    "name": "ai测试1",
    "ruleType": "通用类",
    "level": "S1",
    "conditions": {
      "fileContent": {
        "enabled": true,
        "bodyMatch": {
          "mode": "满足所有",
          "kind": "关键词",
          "value": "ER图"
        }
      }
    }
  }
]
```

### 3. `rules` 包装格式

对应示例文件：`rule-config.batch.json`

```json
{
  "rules": [
    {
      "name": "ai测试1",
      "ruleType": "通用类",
      "level": "S1",
      "enable": true,
      "conditions": {
        "fileContent": {
          "enabled": true,
          "bodyMatch": {
            "mode": "满足所有",
            "kind": "关键词",
            "value": "ER图"
          }
        }
      },
      "usage": {
        "audit": true,
        "api": true
      }
    }
  ]
}
```

### 字段说明

| 字段 | 说明 |
| --- | --- |
| `name` | 规则名称，必填 |
| `ruleType` | 规则类型，必填，例如 `通用类` |
| `description` | 规则描述，可选 |
| `level` | 数据级别，必填，支持 `S1` ~ `S4` |
| `enable` | 是否开启识别，默认 `true` |
| `conditions.fileContent.enabled` | 当前仅支持 `true` |
| `conditions.fileContent.bodyMatch.mode` | `满足所有` / `满足任一` |
| `conditions.fileContent.bodyMatch.kind` | 当前主链路按 `关键词` 处理 |
| `conditions.fileContent.bodyMatch.value` | 匹配值，必填，例如 `ER图` |
| `usage.audit` | 是否用于审计，默认 `true` |
| `usage.api` | 是否用于开放能力，默认 `true` |
| `resourceGroupIds` | 资源组 ID 列表，仅 API 创建时会写入 payload |

## Excel 模版说明

`eagleyun_import_rules_excel.py` 会自动识别这些工作表名称中的优先项：

- `Rules`
- `rules`
- `规则`
- `规则库`
- `导入模板`

支持的 Excel 列名如下，中英文别名都可以：

| 字段 | 是否必填 | 说明 |
| --- | --- | --- |
| `规则名称` / `name` | 是 | 规则名称 |
| `规则类型` / `ruleType` | 是 | 例如 `通用类` |
| `描述` / `description` | 否 | 规则描述 |
| `数据级别` / `level` | 是 | 支持 `S1` ~ `S4` |
| `是否启用` / `enable` | 否 | 默认 `是` |
| `文件内容识别` / `fileContentEnabled` | 否 | 默认 `是`，当前不支持关闭 |
| `匹配关系` / `matchMode` | 否 | `满足所有` / `满足任一` |
| `匹配类型` / `matchKind` | 否 | 当前仅支持 `关键词` |
| `匹配值` / `matchValue` | 是 | 例如 `ER图` |
| `支持审计` / `usageAudit` | 否 | 默认 `是` |
| `支持API` / `usageApi` | 否 | 默认 `是` |
| `资源组ID` / `resourceGroupIds` | 否 | 多个值可用逗号、空格、分号分隔 |

Excel 解析后的 JSON 默认输出到：

```text
.session/excel-import/rule-config.from-excel.json
```

## 关键脚本说明

### `eagleyun_create_rule.js`

这个脚本是纯 API 主入口，流程如下：

1. `GET /` 抓取登录页 HTML 并提取 RSA 公钥
2. `POST /api/anon/usercenter/auth/login` 提交加密后的账号密码
3. 访问 `/overview/default`、`/`、`/dlp/data_identify/default` bootstrap SPA 会话
4. 自动提取 `csrf`
5. 通过 `POST /console/v1/request?path=...` 转发真实 DLP 接口
6. 调用分类接口、标签接口并构造建规则 payload

常用参数：

```text
--base-url
--username
--password
--account-master
--corp-code
--redirect
--target-path
--dlp-prefix
--config
--output-dir
--session-dir
--csrf-token
--dry-run
--apply
```

说明：

- 如果接口自动提取 `csrf` 失败，可以手动传 `--csrf-token`
- 如果账号登录后要求 MFA，纯 API 流程会停止，不会继续做人机交互

### `eagleyun_import_rules_excel.py`

这个脚本负责：

- 读取 Excel
- 做表头归一化
- 转换成 JSON
- 再调用 API 创建脚本或浏览器脚本

脚本自己的参数：

```text
--excel
--template-dir
--sheet
--output-json
--engine auto|api|browser
--only-generate-json
--init-template
```

除以上参数外，传给它的其它参数会透传给 `eagleyun_create_rule.js`，例如 `--base-url`、`--username`、`--password`、`--dlp-prefix`、`--session-dir`。

### `eagleyun_create_rule_browser.js`

这个脚本会：

- 启动带远程调试端口的 Chrome
- 可选复用 `SESSION_FILE` 中的 cookie
- 如果还没登录，会尝试自动填写登录表单
- 进入 DLP 页面，点击“添加规则”
- 按 `RULE_CONFIG_FILE` 中的规则信息填充页面
- 输出页面状态、弹窗截图、请求日志

常用环境变量：

```bash
export RULE_CONFIG_FILE='rule-config.json'
export SESSION_FILE='.session/session.json'
export OUTPUT_DIR='.session/create-rule'
export CHROME_PROFILE_DIR='.chrome-profile/create-rule'
export CHROME_DEBUG_PORT='9222'
export EAGLEYUN_HEADLESS='1'
export DRY_RUN='1'
```

### 登录 / 排障辅助脚本

- `eagleyun_login_api.js`：导出 `session.json`、`cookies.txt`、`cookie-header.txt`、`login-response.json`
- `eagleyun_login.py`：保存登录后的截图，适合排查 Safari 页面可用性
- `eagleyun_login_chrome.py`：保存登录后的页面状态 JSON，适合排查 Chrome 登录页差异
- `inspect_dlp_add_rule_dialog.js`：抓取“添加规则”弹窗的字段、文本、按钮与请求

弹窗排障示例：

```bash
node inspect_dlp_add_rule_dialog.js
```

## 输出目录与调试文件

### API 登录相关

如果是直接运行 `eagleyun_login_api.js`，默认目录是 `.session`；如果是 `eagleyun_create_rule.js` 自动登录过程中产生的会话文件，默认目录是 `.session/api-login`。两者都可以通过 `--session-dir` 覆盖。

常见文件：

- `login-response.json`：登录接口原始响应
- `session.json`：cookie 与基础会话信息
- `cookie-header.txt`：可直接复用的 Cookie 请求头
- `bootstrap-trace.json`：SPA bootstrap 轨迹
- `bootstrap-session.json`：bootstrap 后 cookie 与 `csrf`

### API 创建相关

默认目录：`.session/create-rule-api`

常见文件：

- `rule-config.snapshot.json`：原始配置快照
- `rule-config.normalized.json`：归一化后的规则数组
- `categories.raw.json`：规则分类接口原始响应
- `tags.raw.json`：敏感标签接口原始响应
- `batch-resolved-values.json`：分类编码、敏感标签、`csrf` 等解析结果
- `batch-payloads.dry-run.json` / `batch-payloads.json`：最终请求 payload
- `batch-results.json`：批量执行结果
- `create-payload.dry-run.json` / `create-payload.json`：单条规则时的兼容输出
- `create-request.raw.json`：单条规则创建请求
- `create-response.json`：单条规则创建响应

### Excel / 浏览器批量导入相关

默认目录：

- `.session/excel-import`
- `.session/excel-import/browser-batch`

常见文件：

- `rule-config.from-excel.json`：Excel 转换结果
- `browser-batch/browser-batch-results.json`：浏览器批量执行结果
- `browser-batch/rules/*.json`：逐条规则拆分结果
- 每条规则各自的输出目录中会包含页面状态、截图、请求日志

### 浏览器页面调试相关

`eagleyun_create_rule_browser.js` / `inspect_dlp_add_rule_dialog.js` 常见输出：

- `overview-state.json`
- `dlp-page-state.json`
- `dialog-opened.json` / `dialog.json`
- `filled-dialog.dry-run.json` / `filled-dialog.json`
- `filled-dialog.dry-run.png` / `filled-dialog.png`
- `filled-dialog.dry-run.requests.json` / `filled-dialog.requests.json`
- `after-save-state.json`
- `chrome-stderr.log`

## 已知限制

- API 主链路当前仅支持 `conditions.fileContent.enabled = true`
- API / Excel 主链路当前仅支持“文件正文匹配 -> 关键词”
- API payload 当前只封装了一个关键词项，不支持一次提交多个关键词
- `sensitivedata/tags` 不一定返回 `ER图` 这类细粒度值；仓库中通过 `KNOWN_SENSITIVE_TAGS` 做了兜底映射
- 如果平台后续调整敏感标签编码，需要同步更新 `eagleyun_create_rule.js` 中的映射
- `resourceGroupIds` 目前只在 API 创建时生效，浏览器模式不会在页面上填写该字段
- 批量创建按顺序执行，某一条失败不会回滚已经成功的规则
- API 登录遇到 MFA 或强制改密时会停止，需要改走浏览器路径或人工处理

## 排障建议

如果创建失败，建议按顺序检查：

1. 查看 `.session/api-login/login-response.json`，确认登录是否返回 `code: 200`
2. 查看 `.session/api-login/bootstrap-session.json`，确认是否拿到 `csrfToken`
3. 查看 `.session/create-rule-api/categories.raw.json`，确认 `ruleType` 是否能匹配到分类编码
4. 查看 `.session/create-rule-api/tags.raw.json`，确认敏感标签接口是否返回目标值
5. 查看 `.session/create-rule-api/batch-resolved-values.json`，确认最终落到哪一个标签编码
6. 如果是浏览器模式，查看对应输出目录里的 `.png`、`.json`、`.requests.json`
7. 如果只想确认页面结构是否变化，先单独执行 `node inspect_dlp_add_rule_dialog.js`

## 后续扩展建议

如果接下来还要继续扩能力，建议优先沿用当前 API 主链路继续补：

- 多关键词组合
- 更多规则类型
- 更多匹配条件
- 修改已有规则
- 删除规则
- 更完整的敏感标签解析与缓存

原因是 API 链路更稳定，也更容易做批量导入、幂等校验和失败重试；浏览器脚本更适合作为标签解析异常时的兜底方案，而不是长期主路径。
