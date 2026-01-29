#!/usr/bin/env python3
"""
Constitution Monitor - Tracks changes to Anthropic's constitution page.

This script fetches the constitution page, compares it to the last stored version,
and maintains a changelog of all detected changes.
"""

import os
import sys
import json
import hashlib
import difflib
import requests
from datetime import datetime, timezone
from pathlib import Path
from bs4 import BeautifulSoup

# Configuration
CONSTITUTION_URL = "https://www.anthropic.com/constitution"
VERSIONS_DIR = Path(__file__).parent / "versions"
CHANGELOG_FILE = Path(__file__).parent / "CHANGELOG.md"
LATEST_FILE = VERSIONS_DIR / "latest.txt"
METADATA_FILE = VERSIONS_DIR / "metadata.json"


def fetch_constitution() -> str:
    """Fetch the constitution page and extract text content."""
    print(f"Fetching {CONSTITUTION_URL}...")

    headers = {
        "User-Agent": "ConstitutionMonitor/1.0 (https://github.com/anthropics/constitution-monitor)"
    }

    response = requests.get(CONSTITUTION_URL, headers=headers, timeout=30)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")

    # Remove script and style elements
    for element in soup(["script", "style", "nav", "header", "footer"]):
        element.decompose()

    # Find the main content - look for article or main tags first
    main_content = soup.find("article") or soup.find("main") or soup.find("body")

    if main_content:
        # Get text with some structure preserved
        text = main_content.get_text(separator="\n", strip=True)
    else:
        text = soup.get_text(separator="\n", strip=True)

    # Clean up excessive whitespace while preserving paragraph breaks
    lines = [line.strip() for line in text.split("\n")]
    lines = [line for line in lines if line]  # Remove empty lines
    text = "\n\n".join(lines)

    return text


def get_content_hash(content: str) -> str:
    """Generate a hash of the content for quick comparison."""
    return hashlib.sha256(content.encode()).hexdigest()[:12]


def load_metadata() -> dict:
    """Load metadata about stored versions."""
    if METADATA_FILE.exists():
        return json.loads(METADATA_FILE.read_text())
    return {"versions": []}


def save_metadata(metadata: dict):
    """Save metadata about stored versions."""
    METADATA_FILE.write_text(json.dumps(metadata, indent=2))


def get_latest_version() -> str | None:
    """Get the latest stored version content."""
    if LATEST_FILE.exists():
        return LATEST_FILE.read_text()
    return None


def generate_diff(old_content: str, new_content: str) -> str:
    """Generate a unified diff between old and new content."""
    old_lines = old_content.split("\n")
    new_lines = new_content.split("\n")

    diff = difflib.unified_diff(
        old_lines,
        new_lines,
        fromfile="previous",
        tofile="current",
        lineterm=""
    )

    return "\n".join(diff)


def generate_diff_summary(old_content: str, new_content: str) -> dict:
    """Generate a summary of changes between versions."""
    old_lines = set(old_content.split("\n"))
    new_lines = set(new_content.split("\n"))

    added = new_lines - old_lines
    removed = old_lines - new_lines

    return {
        "lines_added": len(added),
        "lines_removed": len(removed),
        "added_preview": list(added)[:5],
        "removed_preview": list(removed)[:5]
    }


def generate_llm_summary(old_content: str, new_content: str, diff: str) -> str | None:
    """Use Claude API to generate a human-readable summary of changes."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("No ANTHROPIC_API_KEY found, skipping LLM summary")
        return None

    print("Generating LLM summary of changes...")

    prompt = f"""Analyze the following diff of Anthropic's AI constitution and provide a brief,
human-readable summary of what changed. Focus on the substantive changes to principles,
guidelines, or policies. Be concise (2-4 sentences).

DIFF:
{diff[:8000]}  # Truncate if very long

Provide only the summary, no preamble."""

    try:
        response = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json"
            },
            json={
                "model": "claude-sonnet-4-20250514",
                "max_tokens": 500,
                "messages": [{"role": "user", "content": prompt}]
            },
            timeout=30
        )
        response.raise_for_status()
        result = response.json()
        return result["content"][0]["text"]
    except Exception as e:
        print(f"Error generating LLM summary: {e}")
        return None


def update_changelog(timestamp: str, version_hash: str, diff_summary: dict, llm_summary: str | None):
    """Update the changelog file with the new change entry."""
    entry = f"""
## {timestamp}

**Version:** `{version_hash}`

"""

    if llm_summary:
        entry += f"### Summary\n{llm_summary}\n\n"

    entry += f"""### Statistics
- Lines added: {diff_summary['lines_added']}
- Lines removed: {diff_summary['lines_removed']}

"""

    if diff_summary['added_preview']:
        entry += "### Sample of additions\n"
        for line in diff_summary['added_preview'][:3]:
            if line.strip():
                preview = line[:200] + "..." if len(line) > 200 else line
                entry += f"> {preview}\n"
        entry += "\n"

    if diff_summary['removed_preview']:
        entry += "### Sample of removals\n"
        for line in diff_summary['removed_preview'][:3]:
            if line.strip():
                preview = line[:200] + "..." if len(line) > 200 else line
                entry += f"> ~~{preview}~~\n"
        entry += "\n"

    entry += "---\n"

    # Read existing changelog or create header
    if CHANGELOG_FILE.exists():
        existing = CHANGELOG_FILE.read_text()
        # Find where to insert (after the header)
        if "---" in existing:
            parts = existing.split("---", 1)
            header = parts[0] + "---\n"
            rest = parts[1] if len(parts) > 1 else ""
            new_content = header + entry + rest
        else:
            new_content = existing + "\n" + entry
    else:
        header = """# Anthropic Constitution Changelog

This file tracks all detected changes to [Anthropic's Constitution](https://www.anthropic.com/constitution).

Each entry includes:
- Timestamp of when the change was detected
- A summary of what changed
- Statistics on additions/removals

---
"""
        new_content = header + entry

    CHANGELOG_FILE.write_text(new_content)
    print(f"Updated {CHANGELOG_FILE}")


def save_version(content: str, timestamp: str, version_hash: str):
    """Save a new version of the constitution."""
    # Save as latest
    LATEST_FILE.write_text(content)

    # Save timestamped version
    version_file = VERSIONS_DIR / f"{timestamp.replace(':', '-').replace(' ', '_')}_{version_hash}.txt"
    version_file.write_text(content)

    # Update metadata
    metadata = load_metadata()
    metadata["versions"].append({
        "timestamp": timestamp,
        "hash": version_hash,
        "file": version_file.name
    })
    save_metadata(metadata)

    print(f"Saved new version: {version_file.name}")


def main():
    """Main monitoring logic."""
    print("=" * 60)
    print("Constitution Monitor")
    print("=" * 60)

    # Ensure directories exist
    VERSIONS_DIR.mkdir(parents=True, exist_ok=True)

    # Fetch current content
    try:
        current_content = fetch_constitution()
    except Exception as e:
        print(f"Error fetching constitution: {e}")
        sys.exit(1)

    current_hash = get_content_hash(current_content)
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    print(f"Fetched content, hash: {current_hash}")
    print(f"Timestamp: {timestamp}")

    # Get previous version
    previous_content = get_latest_version()

    if previous_content is None:
        # First run - just save the initial version
        print("\nFirst run - saving initial version")
        save_version(current_content, timestamp, current_hash)

        # Create initial changelog
        if not CHANGELOG_FILE.exists():
            CHANGELOG_FILE.write_text("""# Anthropic Constitution Changelog

This file tracks all detected changes to [Anthropic's Constitution](https://www.anthropic.com/constitution).

Each entry includes:
- Timestamp of when the change was detected
- A summary of what changed
- Statistics on additions/removals

---

## {timestamp} (Initial)

**Version:** `{hash}`

Initial snapshot captured. Future changes will be logged here.

---
""".format(timestamp=timestamp, hash=current_hash))

        print("\nInitial version saved. Run again to detect changes.")
        # Set output for GitHub Actions
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a") as f:
                f.write("changed=false\n")
        return

    previous_hash = get_content_hash(previous_content)

    if current_hash == previous_hash:
        print("\nNo changes detected.")
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a") as f:
                f.write("changed=false\n")
        return

    # Changes detected!
    print("\n" + "!" * 60)
    print("CHANGES DETECTED!")
    print("!" * 60)

    # Generate diff
    diff = generate_diff(previous_content, current_content)
    diff_summary = generate_diff_summary(previous_content, current_content)

    print(f"\nChanges: +{diff_summary['lines_added']} / -{diff_summary['lines_removed']} lines")

    # Save diff file
    diff_file = VERSIONS_DIR / f"{timestamp.replace(':', '-').replace(' ', '_')}_{current_hash}.diff"
    diff_file.write_text(diff)
    print(f"Saved diff: {diff_file.name}")

    # Generate LLM summary if available
    llm_summary = generate_llm_summary(previous_content, current_content, diff)
    if llm_summary:
        print(f"\nLLM Summary: {llm_summary}")

    # Save new version
    save_version(current_content, timestamp, current_hash)

    # Update changelog
    update_changelog(timestamp, current_hash, diff_summary, llm_summary)

    # Set outputs for GitHub Actions
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write("changed=true\n")
            f.write(f"summary={llm_summary or 'Changes detected in constitution'}\n")

    print("\nDone! Check CHANGELOG.md for details.")


if __name__ == "__main__":
    main()
