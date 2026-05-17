#!/usr/bin/env python3
"""Log in to the Eagleyun console with Safari WebDriver.

This script uses the built-in ``safaridriver`` on macOS, so it does not
require third-party Python packages. Credentials are read from environment
variables or prompted securely at runtime.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
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
    "请输入",
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
const visibleTexts = Array.from(document.querySelectorAll('body *'))
  .filter(isVisible)
  .map(textOf)
  .filter(Boolean)
  .slice(0, 200);
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
  visibleTexts,
};
"""


class WebDriverError(RuntimeError):
    """Raised when a WebDriver call fails."""


class SafariWebDriver:
    def __init__(self, *, startup_timeout: float = 15.0) -> None:
        self.startup_timeout = startup_timeout
        self.proc: Optional[subprocess.Popen[str]] = None
        self.port: Optional[int] = None
        self.session_id: Optional[str] = None
        self.base_url: Optional[str] = None

    def __enter__(self) -> "SafariWebDriver":
        self.start()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def start(self) -> None:
        if self.proc is not None:
            return
        self.port = self._pick_free_port()
        self.base_url = f"http://127.0.0.1:{self.port}"
        self.proc = subprocess.Popen(
            ["safaridriver", "-p", str(self.port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        self._wait_until_ready()
        payload = {
            "capabilities": {
                "alwaysMatch": {
                    "browserName": "safari",
                    "acceptInsecureCerts": True,
                }
            }
        }
        response = self._request("POST", "/session", payload)
        session_id = response.get("sessionId") or response.get("value", {}).get("sessionId")
        if not session_id:
            raise WebDriverError(f"Unable to create Safari session: {response}")
        self.session_id = session_id

    def close(self) -> None:
        if self.session_id:
            try:
                self._request("DELETE", f"/session/{self.session_id}")
            except Exception:
                pass
            self.session_id = None
        if self.proc is not None:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=5)
            except Exception:
                self.proc.kill()
            finally:
                self.proc = None

    def get(self, url: str) -> None:
        self._request("POST", self._session_path("/url"), {"url": url})

    def execute(self, script: str, args: Optional[Iterable[Any]] = None) -> Any:
        response = self._request(
            "POST",
            self._session_path("/execute/sync"),
            {"script": script, "args": list(args or [])},
        )
        return response.get("value")

    def screenshot(self, path: Path) -> None:
        import base64

        response = self._request("GET", self._session_path("/screenshot"))
        value = response.get("value")
        if not value:
            raise WebDriverError(f"Unable to capture screenshot: {response}")
        path.write_bytes(base64.b64decode(value))

    def _session_path(self, suffix: str) -> str:
        if not self.session_id:
            raise WebDriverError("Safari session has not been created")
        return f"/session/{self.session_id}{suffix}"

    def _wait_until_ready(self) -> None:
        deadline = time.time() + self.startup_timeout
        last_error: Optional[str] = None
        while time.time() < deadline:
            if self.proc is not None and self.proc.poll() is not None:
                stderr = ""
                if self.proc.stderr is not None:
                    stderr = self.proc.stderr.read().strip()
                raise WebDriverError(
                    "safaridriver exited before it became ready. "
                    "Make sure Safari is installed and 'Develop > Allow Remote Automation' is enabled. "
                    f"Details: {stderr or 'no stderr output'}"
                )
            try:
                response = self._request("GET", "/status", allow_sessionless=True)
                if response.get("value", {}).get("ready") is True:
                    return
            except Exception as exc:  # pragma: no cover - best effort retry path
                last_error = str(exc)
            time.sleep(0.25)
        raise WebDriverError(
            "Timed out waiting for safaridriver to start. "
            f"Last error: {last_error or 'unknown'}"
        )

    def _request(self, method: str, path: str, payload: Optional[Dict[str, Any]] = None, *, allow_sessionless: bool = False) -> Dict[str, Any]:
        if not self.base_url:
            raise WebDriverError("Safari driver base URL is not initialized")
        if not allow_sessionless and not self.session_id and path != "/session":
            raise WebDriverError("Safari session has not been created")
        body = None
        headers = {}
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json;charset=UTF-8"
        request = urllib.request.Request(f"{self.base_url}{path}", data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            raise WebDriverError(f"WebDriver HTTP {exc.code} {path}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise WebDriverError(f"WebDriver connection failed for {path}: {exc}") from exc
        if not raw:
            return {}
        response = json.loads(raw)
        value = response.get("value")
        if isinstance(value, dict) and value.get("error"):
            raise WebDriverError(f"WebDriver error for {path}: {value.get('message') or value}")
        return response

    @staticmethod
    def _pick_free_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Log in to the Eagleyun security platform with Safari.")
    parser.add_argument("--url", default=os.environ.get("EAGLEYUN_URL", DEFAULT_URL), help="Login page URL.")
    parser.add_argument(
        "--target-path",
        default=os.environ.get("EAGLEYUN_TARGET_PATH", DEFAULT_POST_LOGIN_PATH),
        help="Expected post-login path. Defaults to EAGLEYUN_TARGET_PATH or /overview/default.",
    )
    parser.add_argument("--username", default=os.environ.get("EAGLEYUN_USERNAME"), help="Login username. Defaults to EAGLEYUN_USERNAME.")
    parser.add_argument("--password", default=os.environ.get("EAGLEYUN_PASSWORD"), help="Login password. Defaults to EAGLEYUN_PASSWORD.")
    parser.add_argument("--timeout", type=float, default=45.0, help="Seconds to wait for the post-login page.")
    parser.add_argument("--screenshot", default="eagleyun-login-result.png", help="Screenshot path captured after the login attempt.")
    parser.add_argument(
        "--close-on-success",
        action="store_true",
        help="Close the browser session immediately after a successful login.",
    )
    parser.add_argument(
        "--dump-page-state",
        action="store_true",
        help="Print detected inputs, buttons, and page text for debugging.",
    )
    return parser.parse_args()


def ensure_credentials(args: argparse.Namespace) -> tuple[str, str]:
    username = args.username or input("Username: ").strip()
    password = args.password or getpass.getpass("Password: ")
    if not username or not password:
        raise SystemExit("Username and password are required.")
    return username, password


def wait_for_document_ready(driver: SafariWebDriver, timeout: float = 20.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = driver.execute("return document.readyState;")
        if state == "complete":
            return
        time.sleep(0.25)
    raise WebDriverError("Timed out waiting for the page to finish loading")


def get_page_state(driver: SafariWebDriver) -> Dict[str, Any]:
    state = driver.execute(PAGE_STATE_JS)
    if not isinstance(state, dict):
        raise WebDriverError(f"Unexpected page state response: {state!r}")
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


def wait_for_login_result(driver: SafariWebDriver, login_url: str, target_path: str, timeout: float) -> Dict[str, Any]:
    deadline = time.time() + timeout
    last_state: Dict[str, Any] = {}
    while time.time() < deadline:
        state = get_page_state(driver)
        last_state = state
        failure_hint = detect_login_failure(state)
        if failure_hint and failure_hint not in {"请输入"}:
            raise WebDriverError(f"The page reported a login failure: {failure_hint}")
        if is_login_successful(state, login_url, target_path):
            return state
        time.sleep(0.5)
    raise WebDriverError(
        f"Timed out waiting for the post-login page ({target_path}). "
        "This usually means the form selectors changed, a captcha/MFA challenge appeared, or Safari remote automation needs manual confirmation. "
        f"Last observed URL: {last_state.get('url', login_url)}"
    )


def debug_print_state(state: Dict[str, Any]) -> None:
    print(json.dumps(state, ensure_ascii=False, indent=2))


def main() -> int:
    args = parse_args()
    username, password = ensure_credentials(args)
    screenshot_path = Path(args.screenshot)

    try:
        with SafariWebDriver() as driver:
            print(f"Opening {args.url}")
            driver.get(args.url)
            wait_for_document_ready(driver)

            tab_result = driver.execute(ENABLE_PASSWORD_LOGIN_JS)
            if isinstance(tab_result, dict) and tab_result.get("clicked"):
                time.sleep(0.8)

            if args.dump_page_state:
                print("Page state before login:")
                debug_print_state(get_page_state(driver))

            login_result = driver.execute(FILL_AND_CLICK_JS, [username, password])
            if not isinstance(login_result, dict) or not login_result.get("ok"):
                raise WebDriverError(f"Unable to locate the login controls: {login_result}")
            print(
                "Filled login form "
                f"(user field placeholder='{login_result.get('usernamePlaceholder', '')}', "
                f"button='{login_result.get('loginButtonText', '')}')"
            )

            state = wait_for_login_result(driver, args.url, args.target_path, args.timeout)
            driver.screenshot(screenshot_path)
            print(f"Login succeeded. Current URL: {state.get('url')}")
            print(f"Screenshot saved to {screenshot_path}")

            if args.dump_page_state:
                print("Page state after login:")
                debug_print_state(state)

            if not args.close_on_success and sys.stdin.isatty():
                input("Browser stays open for verification. Press Enter to close the automation session... ")
            return 0
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        return 130
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
