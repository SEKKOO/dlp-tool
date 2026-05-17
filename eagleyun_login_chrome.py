#!/usr/bin/env python3
"""Log in to the Eagleyun console via Google Chrome + AppleScript.

This fallback avoids Safari WebDriver setup and works on macOS systems with
Google Chrome installed. It drives Chrome by executing JavaScript in the active
automation window.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Any, Dict, Iterable, Optional

DEFAULT_URL = "https://spa.console.eagleyun.cn/"
DEFAULT_POST_LOGIN_PATH = "/overview/default"
SUCCESS_MENU_HINTS = [
    "总览",
    "数据安全",
    "调查审计",
    "系统配置",
    "告警中心",
    "终端管理",
]
LOGIN_FAILURE_HINTS = [
    "账号或密码错误",
    "密码错误",
    "登录失败",
    "验证码",
    "请重试",
]

ENABLE_PASSWORD_LOGIN_JS = r"""
const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
const isVisible = (el) => {
  if (!el || !el.isConnected) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};
const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], .ant-tabs-tab, .ant-radio-button-wrapper, .ant-segmented-item'));
const target = nodes.find((el) => {
  if (!isVisible(el)) return false;
  const text = textOf(el);
  return /密码登录|账号登录/.test(text);
});
if (target) {
  target.click();
  return { clicked: true, text: textOf(target) };
}
return { clicked: false };
"""

FILL_AND_CLICK_JS = r"""
const username = arguments[0];
const password = arguments[1];

const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
const isVisible = (el) => {
  if (!el || !el.isConnected) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};
const attrText = (el) => [
  el.getAttribute('placeholder') || '',
  el.getAttribute('aria-label') || '',
  el.getAttribute('name') || '',
  el.getAttribute('id') || '',
  el.getAttribute('autocomplete') || '',
  el.className || '',
].join(' ').toLowerCase();
const setNativeValue = (el, value) => {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
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
  return { ok: false, reason: 'username_input_not_found', inputs: allInputs.map((el) => ({ type: el.type, placeholder: el.getAttribute('placeholder') || '', visible: isVisible(el) })) };
}
if (!passwordInput) {
  return { ok: false, reason: 'password_input_not_found', inputs: allInputs.map((el) => ({ type: el.type, placeholder: el.getAttribute('placeholder') || '', visible: isVisible(el) })) };
}
if (!loginButton || loginButton.score < 1) {
  return { ok: false, reason: 'login_button_not_found', buttons: buttons.map((el) => ({ text: textOf(el), visible: isVisible(el), className: el.className || '' })) };
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
"""

PAGE_STATE_JS = r"""
const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
const isVisible = (el) => {
  if (!el || !el.isConnected) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};
const visibleInputs = Array.from(document.querySelectorAll('input'))
  .filter(isVisible)
  .map((el) => ({
    type: (el.type || '').toLowerCase(),
    placeholder: el.getAttribute('placeholder') || '',
    name: el.getAttribute('name') || '',
    autocomplete: el.getAttribute('autocomplete') || '',
  }));
const visibleButtons = Array.from(document.querySelectorAll('button, [role="button"], a, .ant-btn'))
  .filter(isVisible)
  .map((el) => textOf(el))
  .filter(Boolean)
  .slice(0, 50);
return {
  url: window.location.href,
  title: document.title,
  readyState: document.readyState,
  bodyText: document.body ? document.body.innerText.slice(0, 4000) : '',
  visibleInputs,
  visibleButtons,
};
"""


class ChromeAutomationError(RuntimeError):
    """Raised when AppleScript or page automation fails."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Log in to the Eagleyun security platform with Google Chrome.")
    parser.add_argument("--url", default=os.environ.get("EAGLEYUN_URL", DEFAULT_URL), help="Login page URL.")
    parser.add_argument(
        "--target-path",
        default=os.environ.get("EAGLEYUN_TARGET_PATH", DEFAULT_POST_LOGIN_PATH),
        help="Expected post-login path. Defaults to EAGLEYUN_TARGET_PATH or /overview/default.",
    )
    parser.add_argument("--username", default=os.environ.get("EAGLEYUN_USERNAME"), help="Login username. Defaults to EAGLEYUN_USERNAME.")
    parser.add_argument("--password", default=os.environ.get("EAGLEYUN_PASSWORD"), help="Login password. Defaults to EAGLEYUN_PASSWORD.")
    parser.add_argument("--timeout", type=float, default=45.0, help="Seconds to wait for the post-login page.")
    parser.add_argument("--state-output", default="eagleyun-login-state.json", help="Debug state file written after a successful login.")
    parser.add_argument("--close-on-success", action="store_true", help="Close the automation window after a successful login.")
    parser.add_argument("--dump-page-state", action="store_true", help="Print page state before and after login.")
    return parser.parse_args()


def ensure_credentials(args: argparse.Namespace) -> tuple[str, str]:
    username = args.username or input("Username: ").strip()
    password = args.password or getpass.getpass("Password: ")
    if not username or not password:
        raise SystemExit("Username and password are required.")
    return username, password


def applescript(script: str, *args: str) -> str:
    proc = subprocess.run(
        ["osascript", "-", *args],
        input=script,
        text=True,
        capture_output=True,
    )
    if proc.returncode != 0:
        raise ChromeAutomationError(proc.stderr.strip() or proc.stdout.strip() or "AppleScript failed")
    return proc.stdout.strip()


def apple_string(value: str) -> str:
    return value


class ChromeAppleScriptDriver:
    def __init__(self) -> None:
        self.window_created = False

    def __enter__(self) -> "ChromeAppleScriptDriver":
        self.start()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def start(self) -> None:
        script = """
        tell application \"Google Chrome\"
          activate
          make new window
        end tell
        """
        applescript(script)
        self.window_created = True
        time.sleep(1.0)

    def close(self) -> None:
        if not self.window_created:
            return
        script = """
        tell application \"Google Chrome\"
          if (count of windows) > 0 then
            close front window
          end if
        end tell
        """
        try:
            applescript(script)
        except Exception:
            pass
        self.window_created = False

    def get(self, url: str) -> None:
        script = """
        on run argv
          set targetUrl to item 1 of argv
          tell application \"Google Chrome\"
            activate
            if (count of windows) = 0 then
              make new window
            end if
            set URL of active tab of front window to targetUrl
          end tell
        end run
        """
        applescript(script, url)

    def execute(self, script: str, args: Optional[Iterable[Any]] = None) -> Any:
        js = wrap_js(script, list(args or []))
        runner = """
        on run argv
          set jsCode to item 1 of argv
          tell application \"Google Chrome\"
            return execute active tab of front window javascript jsCode
          end tell
        end run
        """
        raw = applescript(runner, js)
        if not raw:
            return None
        return json.loads(raw)


def wrap_js(script: str, args: list[Any]) -> str:
    payload = json.dumps(args, ensure_ascii=False)
    return f"""
(() => {{
  const __runner = function() {{
{script}
  }};
  const __result = __runner.apply(null, {payload});
  const __serialized = JSON.stringify(__result);
  return __serialized === undefined ? 'null' : __serialized;
}})();
""".strip()


def wait_for_document_ready(driver: ChromeAppleScriptDriver, timeout: float = 20.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = driver.execute("return document.readyState;")
        if state == "complete":
            return
        time.sleep(0.5)
    raise ChromeAutomationError("Timed out waiting for the page to finish loading")


def get_page_state(driver: ChromeAppleScriptDriver) -> Dict[str, Any]:
    state = driver.execute(PAGE_STATE_JS)
    if not isinstance(state, dict):
        raise ChromeAutomationError(f"Unexpected page state response: {state!r}")
    return state


def is_login_successful(state: Dict[str, Any], login_url: str, target_path: str) -> bool:
    url = str(state.get("url", ""))
    title = str(state.get("title", ""))
    body_text = str(state.get("bodyText", ""))
    visible_inputs = state.get("visibleInputs") or []
    has_password_field = any((item.get("type") or "").lower() == "password" for item in visible_inputs if isinstance(item, dict))
    normalized_target = target_path.rstrip("/") or "/"
    if url:
        try:
            current_path = urllib.parse.urlparse(url).path.rstrip("/") or "/"
        except Exception:
            current_path = ""
        if current_path == normalized_target:
            return True
    if any(hint in body_text for hint in SUCCESS_MENU_HINTS):
        return True
    if url.rstrip("/") != login_url.rstrip("/") and not has_password_field:
        return True
    if title and "登录" not in title and not has_password_field:
        return True
    return False


def detect_login_failure(state: Dict[str, Any]) -> Optional[str]:
    body_text = str(state.get("bodyText", ""))
    for hint in LOGIN_FAILURE_HINTS:
        if hint in body_text:
            return hint
    return None


def wait_for_login_result(driver: ChromeAppleScriptDriver, login_url: str, target_path: str, timeout: float) -> Dict[str, Any]:
    deadline = time.time() + timeout
    last_state: Dict[str, Any] = {}
    while time.time() < deadline:
        state = get_page_state(driver)
        last_state = state
        failure_hint = detect_login_failure(state)
        if failure_hint:
            raise ChromeAutomationError(f"The page reported a login failure: {failure_hint}")
        if is_login_successful(state, login_url, target_path):
            return state
        time.sleep(0.5)
    raise ChromeAutomationError(
        f"Timed out waiting for the post-login page ({target_path}). "
        "This usually means the page showed a captcha/MFA challenge or the form selectors changed. "
        f"Last observed URL: {last_state.get('url', login_url)}"
    )


def main() -> int:
    args = parse_args()
    username, password = ensure_credentials(args)
    state_output = Path(args.state_output)

    try:
        with ChromeAppleScriptDriver() as driver:
            print(f"Opening {args.url}")
            driver.get(args.url)
            wait_for_document_ready(driver)

            tab_result = driver.execute(ENABLE_PASSWORD_LOGIN_JS)
            if isinstance(tab_result, dict) and tab_result.get("clicked"):
                time.sleep(1.0)

            if args.dump_page_state:
                print("Page state before login:")
                print(json.dumps(get_page_state(driver), ensure_ascii=False, indent=2))

            login_result = driver.execute(FILL_AND_CLICK_JS, [username, password])
            if not isinstance(login_result, dict) or not login_result.get("ok"):
                raise ChromeAutomationError(f"Unable to locate the login controls: {login_result}")
            print(
                "Filled login form "
                f"(user field placeholder='{login_result.get('usernamePlaceholder', '')}', "
                f"button='{login_result.get('loginButtonText', '')}')"
            )

            state = wait_for_login_result(driver, args.url, args.target_path, args.timeout)
            state_output.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"Login succeeded. Current URL: {state.get('url')}")
            print(f"Page state saved to {state_output}")

            if args.dump_page_state:
                print("Page state after login:")
                print(json.dumps(state, ensure_ascii=False, indent=2))

            if not args.close_on_success and sys.stdin.isatty():
                input("Chrome stays open for verification. Press Enter to close the automation window... ")
            return 0
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        return 130
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
