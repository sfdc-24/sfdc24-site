#!/usr/bin/env python3
"""The Content Security Policy of every page on www.sfdc24.com.

GitHub Pages cannot set response headers, so each page carries its policy in a
<meta http-equiv="Content-Security-Policy"> tag, early in <head>, before any
script. This file is the one source of those tags:

  BASELINE        what every page gets
  GROUPS          named additions (Google Fonts, Apps Script JSONP, ...)
  PAGES           which groups each page adds, and any page-only sources
  PINNED          a page whose policy is kept exactly as written (conference/)

  python tools/site_csp.py --write      rewrite the meta tag on every page
  python tools/site_csp.py --check      exit 1 if a page is missing its tag, its
                                        tag differs from this file, or the page
                                        loads an origin its policy does not allow
  python tools/site_csp.py --inventory  print page -> origins as a Markdown table

The origin scan is static. It reads each page, the local scripts and styles it
loads (and the scripts those load, the fragments they fetch, and the JSON
config they read a service URL from), and collects every absolute URL in a
place that loads something. It cannot see an address that only a server
returns (the LiveKit signal URL comes back in a join response), so those are
written into GROUPS by hand with the reason next to them.

What a meta tag cannot do, and is deliberately not here: frame-ancestors (the
browser ignores it in a meta tag), X-Frame-Options, HSTS and nosniff. Those are
response headers and need a header-capable proxy in front of GitHub Pages.

Next tightening step: replace 'unsafe-inline' in script-src with sha256 hashes
of each page's inline scripts (conference/ already does this), and remove the
eval in assets/board-ops.js so /ops/ can drop 'unsafe-eval'.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent

ORDER = (
    "default-src",
    "script-src",
    "style-src",
    "font-src",
    "img-src",
    "media-src",
    "connect-src",
    "frame-src",
    "worker-src",
    "manifest-src",
    "object-src",
    "base-uri",
    "form-action",
)

BASELINE: dict[str, list[str]] = {
    "default-src": ["'self'"],
    # 'unsafe-inline': the pages carry large inline scripts and styles. The next
    # step is a hash per inline script, as conference/ already does.
    "script-src": ["'self'", "'unsafe-inline'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:"],
    "connect-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    # No page submits a form unless PAGES says so.
    "form-action": ["'none'"],
}

GROUPS: dict[str, dict[str, list[str]]] = {
    # <link rel="stylesheet" href="https://fonts.googleapis.com/css2?...">; the
    # stylesheet then loads the font files from fonts.gstatic.com.
    "google-fonts": {
        "style-src": ["https://fonts.googleapis.com"],
        "font-src": ["https://fonts.gstatic.com"],
    },
    # The ask path: a JSONP <script> tag to the Apps Script web app.
    # script.google.com answers with a 302 to script.googleusercontent.com, and
    # the redirected script must be allowed too.
    "apps-script-jsonp": {
        "script-src": [
            "https://script.google.com",
            "https://script.googleusercontent.com",
        ],
    },
    "mermaid-11.4.1": {
        "script-src": ["https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"],
    },
    "mermaid-11.17.2": {
        "script-src": ["https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js"],
    },
    "chart.js-4.5.1": {
        "script-src": ["https://cdn.jsdelivr.net/npm/chart.js@4.5.1"],
    },
    # Cloud Run: the studio controller (voice session, sign-in, speak).
    "studio-controller": {
        "connect-src": ["https://sfdc24-studio-controller-96522051727.us-central1.run.app"],
    },
    # Cloud Run: the speech-to-text relay. stream/config.js names the https
    # address; the stream itself is the same host over wss://.
    "stt-relay": {
        "connect-src": [
            "https://sfdc24-stt-relay-yzet4vuplq-uc.a.run.app",
            "wss://sfdc24-stt-relay-yzet4vuplq-uc.a.run.app",
        ],
    },
    # Cloud Run: the guest and presenter join service. Its address is written
    # once, in /data/guest-join.json and /data/present-join.json (serviceUrl),
    # and read from there (see _join_service_origins).
    "conference-guest": {
        "connect-src": [],
    },
    # LiveKit Cloud. The signal address is returned by the join service
    # (livekit_url), so no file names it. The client opens wss:// to it and
    # makes https:// calls to the same project (region list, validate), and a
    # region can be a deeper subdomain, so the wildcard covers *.livekit.cloud.
    # WebRTC media (ICE/TURN) is not governed by CSP.
    "livekit": {
        "connect-src": ["wss://*.livekit.cloud", "https://*.livekit.cloud"],
    },
    # A published canvas bucket: JSON and images.
    "canvas-bucket": {
        "img-src": ["https://storage.googleapis.com"],
        "connect-src": ["https://storage.googleapis.com"],
    },
    # /ops/: the CI panel reads public Actions runs; the board snapshots are
    # read from the snapshot branches on raw.githubusercontent.com.
    "github-public-api": {
        "connect-src": ["https://api.github.com", "https://raw.githubusercontent.com"],
    },
    # A same-origin form post (guest and presenter entry).
    "form-self": {
        "form-action": ["'self'"],
    },
    # /intake/: the Salesforce Web-to-Lead form.
    "form-web-to-lead": {
        "form-action": ["https://webto.salesforce.com"],
    },
    # voice/: the reply audio (and the silent unlock clip) is a data: URL.
    "audio-data": {
        "media-src": ["'self'", "data:"],
    },
    # assets/voice-conversation.js plays a reply line from a blob: URL.
    "audio-blob": {
        "media-src": ["'self'", "blob:"],
    },
}

def _join_service_origins() -> list[str]:
    origins: list[str] = []
    for name in ("data/guest-join.json", "data/present-join.json"):
        try:
            url = json.loads((ROOT / name).read_text(encoding="utf-8")).get("serviceUrl", "")
        except (OSError, ValueError, AttributeError):
            continue
        parts = urlsplit(str(url))
        if parts.scheme == "https" and parts.netloc:
            origin = f"https://{parts.netloc}"
            if origin not in origins:
                origins.append(origin)
    return origins


GROUPS["conference-guest"]["connect-src"] = _join_service_origins()

# Each page: the groups it adds to BASELINE, plus any page-only sources.
# A page not listed gets BASELINE alone.
PAGES: dict[str, dict[str, object]] = {
    "index.html": {"groups": ["apps-script-jsonp"]},
    "dashboard/index.html": {"groups": ["mermaid-11.4.1"]},
    "experience/index.html": {"groups": ["mermaid-11.4.1", "studio-controller", "audio-blob"]},
    "guest/index.html": {"groups": ["conference-guest", "livekit", "form-self"]},
    "intake/index.html": {"groups": ["form-web-to-lead"]},
    "looks/index.html": {"groups": ["google-fonts"]},
    # assets/board-ops.js joins its three parts and runs them with eval().
    # Removing that eval is the step that lets /ops/ drop 'unsafe-eval'.
    "ops/index.html": {
        "groups": ["chart.js-4.5.1", "github-public-api"],
        "extra": {"script-src": ["'unsafe-eval'"]},
    },
    "present/index.html": {"groups": ["conference-guest", "livekit", "form-self"]},
    "review/index.html": {"groups": ["google-fonts"]},
    "stream/index.html": {"groups": ["apps-script-jsonp", "stt-relay"]},
    "studio/index.html": {"groups": ["studio-controller"]},
    "voice/index.html": {"groups": ["google-fonts", "apps-script-jsonp", "audio-data"]},
    "xp/index.html": {"groups": ["studio-controller"]},
    "xray/index.html": {"groups": ["google-fonts"]},
}

# Published prototypes under p/<work-id>/ are written by
# tools/prototype_publisher.py, which seals each one with a digest. That tool
# inserts PROTOTYPE_POLICY when the prototype brings no policy of its own;
# --write never touches p/, and --check holds p/ pages to the same rules (and
# the origin scan) without requiring this exact text.
PROTOTYPE_PREFIX = "p/"
PROTOTYPE_GROUPS = ["google-fonts"]

# Pages whose policy is kept exactly as written here. conference/ already
# shipped a hashed inline script and a narrow policy; this keeps it and adds
# only form-action 'none' (the page has no form).
PINNED: dict[str, str] = {
    "conference/index.html": (
        "default-src 'self'; "
        "script-src 'self' 'sha256-ZkF0NgkDyo27eKcGIUycZsi+5gE1WunbDBvZBKlx/ZM=' "
        "https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' https://storage.googleapis.com; "
        "connect-src 'self' https://storage.googleapis.com; "
        "frame-src 'self' https://design.penpot.app https://room.sfdc24.com; "
        "object-src 'none'; base-uri 'self'; form-action 'none'"
    ),
}

# Absolute URLs that appear in scripts but are never fetched: links a script
# writes into the page, XML namespaces, spec identifiers, and comments.
NOT_A_LOAD: dict[str, str] = {
    "https://github.com": "footer and card links (navigation only)",
    "https://www.linkedin.com": "footer contact link (navigation only)",
    "https://www.sfdc24.com": "canonical and share links (navigation only)",
    "https://sfdc24.com": "share and copy text (navigation only)",
    "http://www.w3.org": "SVG and XHTML namespace identifiers",
    "https://schema.org": "JSON-LD vocabulary identifier",
    "https://aomediacodec.github.io": "an RTP header-extension URI in the media client, never fetched",
    "http://localhost": "a comment and a local-dev allowance in the room clients",
    "http://127.0.0.1": "a comment and a local-dev allowance in the room clients",
    "https://design.penpot.app": "a comment in proto-canvas.js; the frame is allowed on conference/",
    "https://room.sfdc24.com": "a link from the conference page (frame allowed on conference/)",
    "https://conference-gateway-yzet4vuplq-uc.a.run.app": "the team join link on /experience/ (navigation only)",
}

# Pages that do not get a policy: they are not site pages.
EXCLUDED_PREFIXES = ("tests/",)
FRAGMENT_SUFFIX = ".fragment.html"


def site_pages() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "*.html"], cwd=ROOT, capture_output=True, check=True
    ).stdout.decode("utf-8")
    pages = []
    for line in out.splitlines():
        line = line.strip()
        if not line or line.endswith(FRAGMENT_SUFFIX):
            continue
        if line.startswith(EXCLUDED_PREFIXES):
            continue
        pages.append(line)
    return sorted(pages)


# --------------------------------------------------------------------------
# Policy assembly


def policy_directives(page: str) -> dict[str, list[str]]:
    if page in PINNED:
        return parse_policy(PINNED[page])
    if page.startswith(PROTOTYPE_PREFIX):
        spec: dict[str, object] = {"groups": PROTOTYPE_GROUPS}
    else:
        spec = PAGES.get(page, {})
    directives: dict[str, list[str]] = {k: list(v) for k, v in BASELINE.items()}

    def add(name: str, sources: list[str]) -> None:
        current = directives.setdefault(name, [])
        if sources and current == ["'none'"]:
            current.clear()
        for source in sources:
            if source not in current:
                current.append(source)

    for group in spec.get("groups", []):  # type: ignore[union-attr]
        for name, sources in GROUPS[group].items():
            add(name, sources)
    for name, sources in dict(spec.get("extra", {})).items():  # type: ignore[arg-type]
        add(name, list(sources))
    for name, sources in directives.items():
        # A directive other than default-src that names any source must still
        # allow the page's own origin where the baseline did.
        if name in {"font-src", "media-src", "frame-src", "worker-src", "manifest-src"}:
            if "'self'" not in sources and "'none'" not in sources:
                sources.insert(0, "'self'")
    return directives


def render(directives: dict[str, list[str]]) -> str:
    parts = []
    for name in ORDER:
        if name in directives:
            parts.append(name + " " + " ".join(directives[name]))
    for name in directives:
        if name not in ORDER:
            parts.append(name + " " + " ".join(directives[name]))
    return "; ".join(parts)


def policy_for(page: str) -> str:
    if page in PINNED:
        return PINNED[page]
    return render(policy_directives(page))


def prototype_policy() -> str:
    """The policy tools/prototype_publisher.py inserts into a prototype."""
    return policy_for(PROTOTYPE_PREFIX + "<work-id>/index.html")


def parse_policy(text: str) -> dict[str, list[str]]:
    directives: dict[str, list[str]] = {}
    for chunk in text.split(";"):
        tokens = chunk.split()
        if not tokens:
            continue
        name = tokens[0].lower()
        if name not in directives:  # the first occurrence wins, as in browsers
            directives[name] = tokens[1:]
    return directives


# --------------------------------------------------------------------------
# Source matching (CSP Level 3, the subset these pages use)

_HOST_SOURCE = re.compile(
    r"^(?:(?P<scheme>[a-z][a-z0-9+.-]*)://)?(?P<host>\*|(?:\*\.)?[a-z0-9.-]+)"
    r"(?::(?P<port>\d+|\*))?(?P<path>/.*)?$",
    re.I,
)


def _scheme_ok(source_scheme: str, url_scheme: str) -> bool:
    if source_scheme == url_scheme:
        return True
    return (source_scheme, url_scheme) in {("http", "https"), ("https", "wss"), ("http", "ws"), ("ws", "wss"), ("http", "wss")}


def source_allows(source: str, url: str) -> bool:
    """Whether one source expression allows an absolute URL (never 'self')."""
    parts = urlsplit(url)
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").lower()
    if source.startswith("'"):
        return False
    if re.fullmatch(r"[a-z][a-z0-9+.-]*:", source, re.I):
        return _scheme_ok(source[:-1].lower(), scheme)
    match = _HOST_SOURCE.match(source)
    if not match:
        return False
    s_scheme = (match.group("scheme") or "").lower()
    s_host = match.group("host").lower()
    s_path = match.group("path") or ""
    if s_scheme and not _scheme_ok(s_scheme, scheme):
        return False
    if not s_scheme and scheme not in {"https", "wss"}:
        return False
    if s_host.startswith("*."):
        if not host.endswith(s_host[1:]):
            return False
    elif s_host != "*" and s_host != host:
        return False
    port = match.group("port")
    if port and port != "*" and str(parts.port or "") != port:
        return False
    if s_path:
        path = parts.path or "/"
        if s_path.endswith("/"):
            return path.startswith(s_path)
        return path == s_path
    return True


def allowed(directives: dict[str, list[str]], directive: str, url: str) -> bool:
    sources = directives.get(directive)
    if sources is None:
        sources = directives.get("default-src", [])
    return any(source_allows(s, url) for s in sources)


# --------------------------------------------------------------------------
# The static origin scan

URL_IN_TEXT = re.compile(r"""(?P<url>(?:https?|wss?)://[A-Za-z0-9.\-]+(?::\d+)?(?:/[^\s"'`<>()\\$]*)?)""")
JS_LOCAL_LITERAL = re.compile(r"""["'](?P<path>/[A-Za-z0-9_./-]+\.(?:js|css|json|html))(?:\?[^"']*)?["']""")
JS_SIBLING_LITERAL = re.compile(r"""["'](?P<name>[A-Za-z0-9_.-]+\.js)["']""")
CSS_URL = re.compile(r"""(?:@import\s+(?:url\()?|url\()\s*["']?(?P<url>[^"')\s]+)""")
SERVICE_KEY = re.compile(r"(?:service|relay|controller|api|gateway)_?url$", re.I)
JS_COMMENT = re.compile(r"/\*.*?\*/|(?<![:\"'\\])//[^\n]*", re.S)


def _strip_js_comments(text: str) -> str:
    return JS_COMMENT.sub(" ", text)


def _classify_js_url(url: str) -> str:
    low = url.lower()
    if low.startswith(("ws://", "wss://")):
        return "connect-src"
    if "script.google.com/macros/" in low:
        return "script-src"  # a JSONP <script> tag
    path = urlsplit(low).path
    if path.endswith(".js") or "/npm/" in path:
        return "script-src"
    if path.endswith(".css") or "fonts.googleapis.com" in low:
        return "style-src"
    return "connect-src"


class Found:
    def __init__(self) -> None:
        self.loads: dict[str, dict[str, set[str]]] = {}
        self.not_a_load: dict[str, set[str]] = {}
        self.files: list[str] = []

    def add(self, directive: str, url: str, where: str) -> None:
        self.loads.setdefault(directive, {}).setdefault(url, set()).add(where)


def _skip(url: str) -> str | None:
    for prefix, reason in NOT_A_LOAD.items():
        if url == prefix or url.startswith(prefix.rstrip("/") + "/") or url.startswith(prefix + "?") or url.startswith(prefix + "#"):
            return reason
        if prefix.endswith("/") and url.startswith(prefix):
            return reason
    return None


class _PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.items: list[tuple[str, str]] = []  # (directive or kind, url)
        self.inline_scripts: list[str] = []
        self.inline_styles: list[str] = []
        self._in: str | None = None
        self._buf: list[str] = []
        self._media_parent: str | None = None
        self.csp_metas: list[str] = []
        self.first_script_pos: tuple[int, int] | None = None
        self.csp_pos: tuple[int, int] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k.lower(): (v or "") for k, v in attrs}
        t = tag.lower()
        if t == "meta" and a.get("http-equiv", "").lower() == "content-security-policy":
            self.csp_metas.append(a.get("content", ""))
            if self.csp_pos is None:
                self.csp_pos = self.getpos()
        if t == "script":
            if self.first_script_pos is None:
                self.first_script_pos = self.getpos()
            if a.get("src"):
                self.items.append(("script-src", a["src"]))
            else:
                kind = a.get("type", "").lower()
                if kind in {"", "text/javascript", "module", "application/javascript"}:
                    self._in, self._buf = "script", []
        elif t == "style":
            self._in, self._buf = "style", []
        elif t == "link" and a.get("href"):
            rel = set(a.get("rel", "").lower().split())
            if "stylesheet" in rel:
                self.items.append(("style-src", a["href"]))
            elif rel & {"icon", "apple-touch-icon", "mask-icon"}:
                self.items.append(("img-src", a["href"]))
            elif "manifest" in rel:
                self.items.append(("manifest-src", a["href"]))
            elif "preload" in rel or "modulepreload" in rel:
                as_ = a.get("as", "").lower()
                self.items.append(({"script": "script-src", "style": "style-src", "font": "font-src", "image": "img-src", "fetch": "connect-src"}.get(as_, "default-src"), a["href"]))
        elif t == "img":
            if a.get("src"):
                self.items.append(("img-src", a["src"]))
            for part in a.get("srcset", "").split(","):
                if part.strip():
                    self.items.append(("img-src", part.split()[0]))
        elif t in {"audio", "video"}:
            self._media_parent = t
            if a.get("src"):
                self.items.append(("media-src", a["src"]))
            if a.get("poster"):
                self.items.append(("img-src", a["poster"]))
        elif t == "source":
            if a.get("src"):
                self.items.append(("media-src" if self._media_parent else "img-src", a["src"]))
            for part in a.get("srcset", "").split(","):
                if part.strip():
                    self.items.append(("img-src", part.split()[0]))
        elif t == "track" and a.get("src"):
            self.items.append(("media-src", a["src"]))
        elif t in {"iframe", "frame"}:
            for key in ("src", "data-src"):
                if a.get(key):
                    self.items.append(("frame-src", a[key]))
        elif t in {"object", "embed"}:
            self.items.append(("object-src", a.get("data") or a.get("src") or "about:blank"))
        elif t == "form":
            self.items.append(("form-action", a.get("action") or "."))
        elif t == "input" and a.get("type", "").lower() == "image" and a.get("src"):
            self.items.append(("img-src", a["src"]))
        if t in {"button", "input"} and a.get("formaction"):
            self.items.append(("form-action", a["formaction"]))
        for key, value in a.items():
            if key.startswith("data-") and key != "data-src" and URL_IN_TEXT.fullmatch(value.strip()):
                self.items.append(("data-attr", value.strip()))
            if key == "style" and "url(" in value:
                for m in CSS_URL.finditer(value):
                    self.items.append(("img-src", m.group("url")))

    def handle_endtag(self, tag: str) -> None:
        t = tag.lower()
        if t in {"audio", "video"}:
            self._media_parent = None
        if self._in and t == self._in:
            text = "".join(self._buf)
            (self.inline_scripts if self._in == "script" else self.inline_styles).append(text)
            self._in = None

    def handle_data(self, data: str) -> None:
        if self._in:
            self._buf.append(data)


def _resolve_local(ref: str, base_file: str) -> str | None:
    """A site-relative or file-relative reference to a repository path."""
    ref = ref.split("#", 1)[0].split("?", 1)[0]
    if not ref or re.match(r"^[a-z][a-z0-9+.-]*:", ref, re.I) or ref.startswith("//"):
        return None
    if ref.startswith("/"):
        rel = ref.lstrip("/")
    else:
        rel = (Path(base_file).parent / ref).as_posix()
    if rel.endswith("/") or rel == "":
        rel = rel + "index.html"
    path = (ROOT / rel).resolve()
    try:
        return path.relative_to(ROOT).as_posix() if path.is_file() else None
    except ValueError:
        return None


def _absolute(ref: str) -> str | None:
    ref = ref.strip()
    if ref.startswith("//"):
        return "https:" + ref
    if re.match(r"^(?:https?|wss?)://", ref, re.I):
        return ref
    return None


def scan_page(page: str) -> Found:
    found = Found()
    seen: set[str] = set()
    _scan_html_file(page, page, found, seen, is_page=True)
    return found


def _record(found: Found, directive: str, url: str, where: str, structural: bool = False) -> None:
    """structural: a tag attribute that loads by definition (never skipped)."""
    reason = None if structural else _skip(url)
    if reason:
        found.not_a_load.setdefault(urlsplit(url).scheme + "://" + (urlsplit(url).netloc), set()).add(where)
        return
    found.add(directive, url, where)


def _scan_html_file(path: str, page: str, found: Found, seen: set[str], is_page: bool = False) -> _PageParser:
    seen.add(path)
    found.files.append(path)
    text = (ROOT / path).read_text(encoding="utf-8")
    parser = _PageParser()
    parser.feed(text)
    parser.close()
    for directive, ref in parser.items:
        url = _absolute(ref)
        if directive == "data-attr":
            if url:
                _record(found, "connect-src", url, path)
            continue
        if url:
            _record(found, directive, url, path, structural=True)
            continue
        if directive == "form-action":
            found.add("form-action", "'self'", path)
            continue
        local = _resolve_local(ref, path)
        if local and local not in seen:
            if local.endswith(".js") and directive == "script-src":
                _scan_js_file(local, found, seen)
            elif local.endswith(".css") and directive == "style-src":
                _scan_css_file(local, found, seen)
    for script in parser.inline_scripts:
        _scan_js_text(script, path, found, seen)
    for style in parser.inline_styles:
        _scan_css_text(style, path, found, seen)
    return parser


def _scan_css_file(path: str, found: Found, seen: set[str]) -> None:
    seen.add(path)
    found.files.append(path)
    _scan_css_text((ROOT / path).read_text(encoding="utf-8"), path, found, seen)


def _scan_css_text(text: str, where: str, found: Found, seen: set[str]) -> None:
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    for m in CSS_URL.finditer(text):
        ref = m.group("url")
        url = _absolute(ref)
        is_import = text[max(0, m.start()):m.start() + 7] == "@import"
        if url:
            directive = "style-src" if is_import else ("font-src" if re.search(r"\.(woff2?|ttf|otf)(\?|$)", url) else "img-src")
            _record(found, directive, url, where)
        elif is_import:
            local = _resolve_local(ref, where)
            if local and local not in seen:
                _scan_css_file(local, found, seen)


def _scan_js_file(path: str, found: Found, seen: set[str]) -> None:
    seen.add(path)
    found.files.append(path)
    _scan_js_text((ROOT / path).read_text(encoding="utf-8"), path, found, seen)


def _scan_js_text(text: str, where: str, found: Found, seen: set[str]) -> None:
    code = _strip_js_comments(text)
    for m in URL_IN_TEXT.finditer(code):
        url = m.group("url").rstrip(".,;")
        # A URL used only as a prefix check or a regular expression is not a
        # load; only quoted literals count.
        before = code[max(0, m.start() - 1):m.start()]
        if before not in {'"', "'", "`"}:
            continue
        _record(found, _classify_js_url(url), url, where)
    for m in JS_LOCAL_LITERAL.finditer(code):
        local = _resolve_local(m.group("path"), where)
        if not local or local in seen:
            continue
        if local.endswith(".js"):
            _scan_js_file(local, found, seen)
        elif local.endswith(".css"):
            _scan_css_file(local, found, seen)
        elif local.endswith(".html") and local.endswith(FRAGMENT_SUFFIX):
            _scan_html_file(local, where, found, seen)
        elif local.endswith(".json"):
            _scan_json_config(local, found, seen)
    for m in JS_SIBLING_LITERAL.finditer(code):
        sibling = (Path(where).parent / m.group("name")).as_posix()
        if (ROOT / sibling).is_file() and sibling not in seen and sibling.endswith(".js"):
            _scan_js_file(sibling, found, seen)


def _scan_json_config(path: str, found: Found, seen: set[str]) -> None:
    """A JSON file a script reads a service address from (serviceUrl, ...)."""
    seen.add(path)
    try:
        data = json.loads((ROOT / path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return

    def walk(node: object) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                if isinstance(value, str) and SERVICE_KEY.search(str(key)) and _absolute(value):
                    found.files.append(path)
                    _record(found, "connect-src", value, path)
                else:
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(data)


# --------------------------------------------------------------------------
# Writing and checking the tags

META_RE = re.compile(r'<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*">[ \t]*\r?\n?', re.I)
HEAD_RE = re.compile(r"<head\b[^>]*>", re.I)
CHARSET_RE = re.compile(r"<meta\s+charset=[^>]*>", re.I)


def meta_tag(page: str) -> str:
    return '<meta http-equiv="Content-Security-Policy" content="%s">' % policy_for(page)


def with_meta(page: str, text: str) -> str:
    newline = "\r\n" if "\r\n" in text[:4096] else "\n"
    tag = meta_tag(page)
    existing = META_RE.search(text)
    if existing:
        start, end = existing.span()
        trailing = text[start:end]
        ending = newline if trailing.endswith("\n") else ""
        return text[:start] + tag + ending + text[end:]
    head = HEAD_RE.search(text)
    if not head:
        raise SystemExit(f"{page}: no <head>")
    head_end = head.end()
    first_script = text.find("<script", head_end)
    charset = CHARSET_RE.search(text, head_end)
    at = head_end
    if charset and (first_script == -1 or charset.start() < first_script):
        at = charset.end()
    return text[:at] + newline + tag + text[at:]


def write_all() -> list[str]:
    changed = []
    for page in site_pages():
        if page.startswith(PROTOTYPE_PREFIX):
            continue  # sealed by tools/prototype_publisher.py
        path = ROOT / page
        raw = path.read_bytes()
        text = raw.decode("utf-8")
        new = with_meta(page, text)
        if new != text:
            path.write_bytes(new.encode("utf-8"))
            changed.append(page)
    return changed


def check_page(page: str) -> list[str]:
    problems: list[str] = []
    text = (ROOT / page).read_text(encoding="utf-8")
    parser = _PageParser()
    parser.feed(text)
    parser.close()
    if not parser.csp_metas:
        return [f"{page}: no Content-Security-Policy meta tag"]
    if len(parser.csp_metas) > 1:
        problems.append(f"{page}: {len(parser.csp_metas)} Content-Security-Policy meta tags (one only)")
    content = parser.csp_metas[0]
    expected = policy_for(page)
    if content != expected and not page.startswith(PROTOTYPE_PREFIX):
        problems.append(f"{page}: the meta policy differs from tools/site_csp.py; run python tools/site_csp.py --write")
    if parser.first_script_pos and parser.csp_pos and parser.first_script_pos < parser.csp_pos:
        problems.append(f"{page}: a script comes before the Content-Security-Policy meta tag")
    head_close = text.lower().find("</head>")
    if head_close != -1 and text.find(content) > head_close:
        problems.append(f"{page}: the Content-Security-Policy meta tag is not inside <head>")
    directives = parse_policy(content)
    if "frame-ancestors" in directives or "report-uri" in directives or "sandbox" in directives:
        problems.append(f"{page}: frame-ancestors, report-uri and sandbox are ignored in a meta tag")
    for required, value in (("object-src", ["'none'"]), ("base-uri", ["'self'"])):
        if directives.get(required) != value:
            problems.append(f"{page}: {required} must be {' '.join(value)}")
    if "form-action" not in directives:
        problems.append(f"{page}: form-action is missing")
    if "'unsafe-eval'" in directives.get("script-src", []) and page != "ops/index.html":
        problems.append(f"{page}: 'unsafe-eval' is allowed only on ops/ (assets/board-ops.js)")
    script_src = directives.get("script-src", directives.get("default-src", []))
    if "https://script.google.com" in script_src and "https://script.googleusercontent.com" not in script_src:
        problems.append(f"{page}: Apps Script JSONP redirects to script.googleusercontent.com; allow both")
    found = scan_page(page)
    for directive, urls in sorted(found.loads.items()):
        for url, where in sorted(urls.items()):
            if url == "'self'":
                if not (directives.get(directive) and "'self'" in directives[directive]):
                    problems.append(f"{page}: a form posts to this origin but form-action does not allow 'self' ({', '.join(sorted(where))})")
                continue
            if not allowed(directives, directive, url):
                problems.append(f"{page}: {directive} does not allow {url} (from {', '.join(sorted(where))})")
    return problems


def check_all() -> list[str]:
    problems: list[str] = []
    pages = site_pages()
    for page in pages:
        problems.extend(check_page(page))
    for page in list(PAGES) + list(PINNED):
        if page not in pages:
            problems.append(f"tools/site_csp.py names {page}, which is not a site page")
    return problems


def origin_of(url: str) -> str:
    if url == "'self'":
        return url
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


def inventory_rows() -> list[tuple[str, dict[str, list[str]]]]:
    rows = []
    for page in site_pages():
        found = scan_page(page)
        per: dict[str, list[str]] = {}
        for directive, urls in sorted(found.loads.items()):
            origins = sorted({origin_of(u) for u in urls if u != "'self'"})
            if directive == "form-action" and "'self'" in urls:
                origins = ["'self'"] + origins
            if origins:
                per[directive] = origins
        rows.append((page, per))
    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true")
    group.add_argument("--check", action="store_true")
    group.add_argument("--inventory", action="store_true")
    group.add_argument("--policy", metavar="PAGE")
    args = parser.parse_args(argv)
    if args.write:
        for page in write_all():
            print("wrote", page)
        return 0
    if args.check:
        problems = check_all()
        for problem in problems:
            print(problem)
        print(f"{len(site_pages())} pages checked, {len(problems)} problems")
        return 1 if problems else 0
    if args.policy:
        print(policy_for(args.policy))
        return 0
    print("| Page | Origins it loads (by directive) |")
    print("|---|---|")
    for page, per in inventory_rows():
        cell = "; ".join(f"{d}: {' '.join(o)}" for d, o in per.items()) or "own origin only"
        print(f"| `{page}` | {cell} |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
