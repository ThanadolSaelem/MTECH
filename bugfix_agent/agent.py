#!/usr/bin/env python3
"""
AI Bug-Fix Agent for MTECH / FinFin GAS
Polls GAS notifications/list for errors, uses Claude Opus 4.7 (with adaptive
thinking + prompt caching) to diagnose and generate code fixes, then opens
GitHub PRs automatically for human review.
"""

import hashlib
import html as _html
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import anthropic
import requests
from github import Github

# ── Paths & secrets ────────────────────────────────────────────────────────────
REPO_ROOT    = Path(__file__).parent.parent
AGENT_DIR    = Path(__file__).parent
SEEN_FILE    = AGENT_DIR / "seen_errors.json"
GS_FILES     = sorted(REPO_ROOT.glob("*.gs"))

GAS_URL           = os.environ.get("GAS_URL", "")
GAS_API_KEY       = os.environ.get("GAS_API_KEY", "")
GITHUB_TOKEN      = os.environ.get("GITHUB_TOKEN", "")
GITHUB_REPO       = os.environ.get("GITHUB_REPOSITORY", "thanadolsaelem/mtech")
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")

MODEL             = "claude-opus-4-7"
OPENROUTER_MODEL  = "nvidia/nemotron-3-super-120b-a12b:free"  # fallback via OpenRouter

# ── Build codebase context (cached in prompt) ──────────────────────────────────
def _build_codebase() -> str:
    parts = []
    for p in GS_FILES:
        parts.append(f"=== FILE: {p.name} ===\n{p.read_text(encoding='utf-8')}\n")
    return "\n".join(parts)

_CODEBASE = _build_codebase()

_SYSTEM = f"""You are an expert Google Apps Script (GAS) developer specializing in Thai \
accounting automation. The system (FinFin / MTECH) automates document creation in PEAK \
accounting software using Google Sheets as the data source. It processes receipts (Part 1 \
tax invoice), invoices (Part 2), late fees (Part 3), credit notes (Part 4), and statement \
matching (Part 5).

Complete GAS codebase:

{_CODEBASE}

When given an error log entry your job is:
1. Diagnose the root cause from the error message and relevant code.
2. Decide: is this a CODE bug (fixable by editing a .gs file)?
   - YES if the bug is in the GAS logic above.
   - NO if it is a data issue, PEAK API outage, missing sheet, config/credentials problem,
     or anything not fixed by changing code.
3. If fixable: produce an exact search-and-replace patch for the correct .gs file.
   The "search" string MUST appear verbatim in that file (copy it exactly).
4. Return ONLY a valid JSON object — no markdown fences, no text outside the JSON.

JSON schema (all fields required when fixable=true):
{{
  "fixable": true,
  "diagnosis": "1–2 sentences on root cause",
  "file": "XX_Filename.gs",
  "search": "exact text to find (multiline ok)",
  "replace": "replacement text",
  "pr_title": "fix(PartX): short description",
  "pr_body": "## Problem\\n...\\n## Fix\\n..."
}}

JSON schema when NOT fixable:
{{
  "fixable": false,
  "diagnosis": "1–2 sentences on why this is not a code bug"
}}"""


# ── Deduplication ──────────────────────────────────────────────────────────────
def _load_seen() -> set:
    if SEEN_FILE.exists():
        return set(json.loads(SEEN_FILE.read_text(encoding="utf-8")))
    return set()


def _save_seen(seen: set) -> None:
    SEEN_FILE.write_text(json.dumps(sorted(seen), indent=2, ensure_ascii=False),
                         encoding="utf-8")


def _fingerprint(err: dict) -> str:
    key = f"{err.get('part','')}:{err.get('inv','')}:{err.get('msg','')}"
    return hashlib.md5(key.encode()).hexdigest()


# ── Telegram notification ──────────────────────────────────────────────────────
def _send_telegram(new_errors: list) -> None:
    token   = os.getenv("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.getenv("TELEGRAM_CHAT_ID", "")
    if not token or not chat_id:
        return

    now = datetime.now(timezone.utc).strftime("%d/%m/%Y %H:%M UTC")
    lines = [
        f"\U0001f6a8 <b>MTECH — Error ใหม่ {len(new_errors)} รายการ</b>",
        f"<i>{now}</i>",
        "",
    ]
    for e in new_errors[:10]:
        ts   = str(e.get("ts", ""))[:16].replace("T", " ")
        part = _html.escape(str(e.get("part", "")))
        inv  = _html.escape(str(e.get("inv",  "")))
        msg  = _html.escape(str(e.get("msg",  ""))[:200])
        lines.append(f"• <code>[{part}]</code> {inv}")
        lines.append(f"  {msg}")
        lines.append(f"  <i>{ts}</i>")
        lines.append("")
    if len(new_errors) > 10:
        lines.append(f"<i>... และอีก {len(new_errors) - 10} รายการ</i>")
    lines.append("\U0001f916 กำลังวิเคราะห์และสร้าง PR อัตโนมัติ...")

    try:
        r = requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": "\n".join(lines), "parse_mode": "HTML"},
            timeout=10,
        )
        if r.ok:
            print(f"  ✓ Telegram sent ({len(new_errors)} errors)")
        else:
            print(f"  ⚠ Telegram failed: {r.status_code} {r.text[:100]}")
    except Exception as exc:
        print(f"  ⚠ Telegram error: {exc}")


# ── GAS polling ────────────────────────────────────────────────────────────────
def _fetch_errors() -> list:
    resp = requests.post(
        GAS_URL,
        json={"action": "notifications/list", "apiKey": GAS_API_KEY, "params": {}},
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()
    if not body.get("ok"):
        raise RuntimeError(f"GAS error: {body.get('error')}")
    return body.get("data", {}).get("errors", [])


# ── Claude analysis ────────────────────────────────────────────────────────────
def _parse_json(text: str) -> dict | None:
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if m:
        text = m.group(1)
    m2 = re.search(r"\{.*\}", text, re.DOTALL)
    if m2:
        text = m2.group(0)
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        print(f"    ⚠ JSON parse failed: {e} — raw: {text[:300]}")
        return None


def _user_msg(error: dict) -> str:
    return (
        "Error log entry to diagnose and fix:\n"
        f"  part:  {error.get('part', '')}\n"
        f"  sheet: {error.get('sheet', '')}\n"
        f"  row:   {error.get('row', '')}\n"
        f"  inv:   {error.get('inv', '')}\n"
        f"  ts:    {error.get('ts', '')}\n"
        f"  msg:   {error.get('msg', '')}\n\n"
        "Return ONLY the JSON object."
    )


def _analyze_anthropic(client: anthropic.Anthropic, error: dict) -> dict | None:
    resp = client.messages.create(
        model=MODEL,
        max_tokens=4096,
        thinking={"type": "adaptive"},
        system=[{"type": "text", "text": _SYSTEM, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": _user_msg(error)}],
    )
    text = next((b.text.strip() for b in resp.content if b.type == "text"), "")
    if not text:
        print("    ⚠ Anthropic returned no text block")
        return None
    return _parse_json(text)


def _analyze_openrouter(error: dict) -> dict | None:
    if not OPENROUTER_API_KEY:
        print("    ⚠ OPENROUTER_API_KEY not set — cannot fall back")
        return None
    print("    ↩ Falling back to OpenRouter …")
    resp = requests.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/ThanadolSaelem/MTECH",
        },
        json={
            "model": OPENROUTER_MODEL,
            "max_tokens": 4096,
            "messages": [
                {"role": "system", "content": _SYSTEM},
                {"role": "user",   "content": _user_msg(error)},
            ],
        },
        timeout=120,
    )
    resp.raise_for_status()
    text = resp.json()["choices"][0]["message"]["content"].strip()
    return _parse_json(text)


def _analyze(client: anthropic.Anthropic, error: dict) -> dict | None:
    try:
        return _analyze_anthropic(client, error)
    except anthropic.APIError as exc:
        print(f"    ⚠ Anthropic API error ({type(exc).__name__}: {exc}) — trying OpenRouter")
        return _analyze_openrouter(error)


# ── GitHub PR creation ─────────────────────────────────────────────────────────
def _create_pr(gh: Github, analysis: dict, error: dict) -> str | None:
    repo = gh.get_repo(GITHUB_REPO)

    file_name = analysis["file"]
    search    = analysis["search"]
    replace   = analysis["replace"]
    pr_title  = analysis["pr_title"]
    pr_body   = analysis["pr_body"]

    contents = repo.get_contents(file_name)
    old_text = contents.decoded_content.decode("utf-8")

    if search not in old_text:
        print(f"    ⚠ search string not found in {file_name} — skipping PR")
        return None

    new_text = old_text.replace(search, replace, 1)
    if new_text == old_text:
        print(f"    ⚠ replacement produced no change — skipping PR")
        return None

    # Branch name
    ts_slug   = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    part_slug = re.sub(r"[^a-z0-9]", "-", error.get("part", "bug").lower()).strip("-")
    branch    = f"bugfix/ai-{part_slug}-{ts_slug}"

    main_sha = repo.get_branch("main").commit.sha
    repo.create_git_ref(ref=f"refs/heads/{branch}", sha=main_sha)

    repo.update_file(
        path=file_name,
        message=f"{pr_title}\n\nAuto-fix by Claude Opus 4.7 bugfix agent",
        content=new_text,
        sha=contents.sha,
        branch=branch,
    )

    pr = repo.create_pull(
        title=pr_title,
        body=(
            f"{pr_body}\n\n---\n"
            f"**Error log entry:**\n"
            f"- part: `{error.get('part')}`\n"
            f"- inv: `{error.get('inv')}`\n"
            f"- ts: `{error.get('ts')}`\n"
            f"- msg: `{error.get('msg')}`\n\n"
            f"*Auto-generated by AI bugfix agent — review carefully before merging.*"
        ),
        head=branch,
        base="main",
    )
    return pr.html_url


# ── Main ───────────────────────────────────────────────────────────────────────
def main() -> None:
    print(f"[{datetime.now(timezone.utc).isoformat()}] AI bugfix agent starting")

    for var in ("GAS_URL", "GAS_API_KEY", "GITHUB_TOKEN"):
        if not os.environ.get(var):
            print(f"  ✗ Missing env var: {var}")
            sys.exit(1)
    if not os.environ.get("ANTHROPIC_API_KEY") and not os.environ.get("OPENROUTER_API_KEY"):
        print("  ✗ Must set at least one of: ANTHROPIC_API_KEY, OPENROUTER_API_KEY")
        sys.exit(1)

    seen = _load_seen()
    print(f"  Seen fingerprints: {len(seen)}")

    try:
        errors = _fetch_errors()
    except Exception as exc:
        print(f"  ✗ GAS fetch failed: {exc}")
        sys.exit(1)

    print(f"  GAS errors total: {len(errors)}")
    new_errors = [e for e in errors if _fingerprint(e) not in seen]
    print(f"  New (unseen): {len(new_errors)}")

    if not new_errors:
        print("  Nothing to do.")
        return

    _send_telegram(new_errors)

    client = anthropic.Anthropic()
    gh     = Github(GITHUB_TOKEN)
    prs_created = 0

    for error in new_errors:
        fp = _fingerprint(error)
        print(f"\n  → part={error.get('part')}  inv={error.get('inv')}  "
              f"msg={str(error.get('msg',''))[:80]}")

        try:
            analysis = _analyze(client, error)
        except Exception as exc:
            print(f"    ✗ Claude error: {exc}")
            seen.add(fp)
            continue

        if not analysis:
            seen.add(fp)
            continue

        if not analysis.get("fixable"):
            print(f"    ℹ Not a code bug: {analysis.get('diagnosis', '')}")
            seen.add(fp)
            continue

        print(f"    ✓ Fix: {analysis.get('pr_title')}")

        try:
            url = _create_pr(gh, analysis, error)
        except Exception as exc:
            print(f"    ✗ GitHub error: {exc}")
            continue  # Don't mark seen — retry next cycle

        if url:
            print(f"    ✓ PR: {url}")
            prs_created += 1

        seen.add(fp)
        time.sleep(3)  # Rate-limit between Claude calls

    _save_seen(seen)
    print(f"\n[Done] PRs created: {prs_created}  |  Seen total: {len(seen)}")


if __name__ == "__main__":
    main()
