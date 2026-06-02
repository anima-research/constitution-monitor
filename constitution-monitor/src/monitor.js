import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import * as cheerio from 'cheerio';
import * as Diff from 'diff';
import { getCorrection } from './corrections.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const VERSIONS_DIR = path.join(ROOT_DIR, 'versions');
const CHANGELOG_FILE = path.join(ROOT_DIR, 'CHANGELOG.md');
const LATEST_FILE = path.join(VERSIONS_DIR, 'latest.txt');
const METADATA_FILE = path.join(VERSIONS_DIR, 'metadata.json');
// Operational run status (NOT committed to git — see .gitignore). Lets us tell
// whether the monitor is healthy vs. silently skipping runs (e.g. if the page
// is restructured again), rather than only finding out from logs.
const STATUS_FILE = path.join(VERSIONS_DIR, 'monitor-status.json');

const CONSTITUTION_URL = 'https://www.anthropic.com/constitution';

// ---------------------------------------------------------------------------
// Content validation
//
// The PRIMARY guard against recording a broken read is structural: the new
// extractor (below) reads the structured Sanity document, so a fetch either
// yields the whole `featureClaudeConstitution` document or fetchConstitution()
// throws. The "got half the page" partial read that caused the 2026-05-11
// false "constitution removed" alarm (an artifact of the old DOM scraper)
// cannot recur with structured extraction.
//
// This check is therefore only a lightweight backstop against the one
// remaining failure mode: a structurally-valid but GUTTED read (e.g. a CMS
// hiccup that returns an empty `chapters` array). A generous length floor
// catches that — the real document is ~190k chars, and without the body
// chapters it would be ~30k. We deliberately do NOT validate specific prose
// (landmark phrases) or relative size: those would risk rejecting a genuine
// edit (a reworded section, a real trim) as "incomplete", silently pausing
// tracking — the wrong failure for a change monitor. We treat an actual mass
// deletion of the constitution as implausible.
// ---------------------------------------------------------------------------
const MIN_CONTENT_LENGTH = 80000;

/**
 * Lightweight sanity check that a successful extraction isn't empty/gutted.
 * Returns { valid, problems }. Never throws.
 */
export function validateConstitutionContent(content) {
  const problems = [];
  if (!content || content.length < MIN_CONTENT_LENGTH) {
    problems.push(`content length ${content ? content.length : 0} is below floor ${MIN_CONTENT_LENGTH} (likely an incomplete or empty read)`);
  }
  return { valid: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Extraction from the RSC flight payload
//
// The constitution document is delivered as a Sanity object of type
// "featureClaudeConstitution" embedded in the flight stream. Its prose is a
// mix of Sanity Portable Text (blocks of spans) and large RSC text blobs
// (rows of the form `<id>:T<hexlen>,<text>`) that are referenced from span
// text values as `$<id>`. We parse the rows, locate the constitution document,
// and walk it — resolving text-blob references and concatenating span text —
// to reconstruct the complete document deterministically.
// ---------------------------------------------------------------------------

// Fields of the constitution document that are NOT part of the prose
// (audio-chapter nav, download buttons, SEO metadata, system fields).
const NON_CONTENT_FIELDS = new Set([
  'audiobook', 'downloadCtas', 'meta', 'seo', 'slug', 'language',
  '_id', '_type', '_rev', '_createdAt', '_updatedAt',
]);
// Preferred reading order for the known content fields. Any other (non-excluded)
// fields are appended afterwards so new content sections are still captured.
const CONTENT_FIELD_ORDER = ['hero', 'chapters', 'acknowledgements'];
// Portable Text structural/metadata keys to skip when walking.
const PT_SKIP_KEYS = new Set([
  '_key', '_type', '_id', 'marks', 'markDefs', 'style', 'listItem', 'level',
  'href', 'url', 'className', 'id', 'language', 'alt', 'asset', '_ref',
]);

/** Concatenate the decoded strings from all `self.__next_f.push([n,"..."])` calls. */
function extractFlightBuffer(html) {
  const $ = cheerio.load(html);
  let flight = '';
  $('script').each((i, el) => {
    const t = $(el).text();
    if (t.includes('self.__next_f.push')) {
      const m = t.match(/self\.__next_f\.push\(\[\d+,(.*)\]\)/s);
      if (m) {
        try { flight += JSON.parse(m[1]); } catch { /* non-string push payload */ }
      }
    }
  });
  return flight;
}

/**
 * Parse the flight buffer into rows. Text-blob rows (`<id>:T<hexlen>,<bytes>`)
 * are read by their declared byte length (their content may contain newlines);
 * all other rows run to the next newline. Byte-accurate via Buffer.
 */
function parseFlightRows(flight) {
  const buf = Buffer.from(flight, 'utf8');
  const rows = [];
  let p = 0;
  while (p < buf.length) {
    const colon = buf.indexOf(0x3a, p); // ':'
    if (colon < 0) break;
    const id = buf.toString('utf8', p, colon);
    if (!/^[0-9a-f]{1,6}$/i.test(id)) { // not a row header; advance to next line
      const nl = buf.indexOf(0x0a, p);
      if (nl < 0) break;
      p = nl + 1;
      continue;
    }
    const q = colon + 1;
    const type = String.fromCharCode(buf[q]);
    if (type === 'T') {
      const comma = buf.indexOf(0x2c, q + 1); // ','
      const len = parseInt(buf.toString('utf8', q + 1, comma), 16);
      const text = buf.toString('utf8', comma + 1, comma + 1 + len);
      rows.push({ id, type: 'T', text });
      p = comma + 1 + len;
      if (buf[p] === 0x0a) p++;
    } else {
      let nl = buf.indexOf(0x0a, q);
      if (nl < 0) nl = buf.length;
      rows.push({ id, type, payload: buf.toString('utf8', q, nl) });
      p = nl + 1;
    }
  }
  return rows;
}

/** Recursively find the first object with the given `_type`. */
function findByType(node, type) {
  if (node == null || typeof node !== 'object') return null;
  if (!Array.isArray(node) && node._type === type) return node;
  for (const v of (Array.isArray(node) ? node : Object.values(node))) {
    const found = findByType(v, type);
    if (found) return found;
  }
  return null;
}

/** Walk the constitution document, resolving text-blob refs + Portable Text. */
function renderConstitutionDoc(doc, tBlobs) {
  const out = [];
  const pushString = (v) => {
    const ref = /^\$([0-9a-f]+)$/i.exec(v);
    if (ref) { // RSC reference to a text blob
      if (tBlobs.has(ref[1])) out.push(tBlobs.get(ref[1]));
      return;
    }
    if (v.startsWith('$')) return; // other RSC sentinel/component reference
    out.push(v);
  };
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'string') { pushString(v); return; }
    if (Array.isArray(v)) {
      // RSC element: ["$", type, key, props]
      if (v[0] === '$' && v.length >= 4 && v[3] && typeof v[3] === 'object') { walk(v[3].children); return; }
      for (const x of v) walk(x);
      return;
    }
    if (typeof v === 'object') {
      if (v._type === 'span' && typeof v.text === 'string') { pushString(v.text); return; }
      if (v._type === 'block' && Array.isArray(v.children)) {
        for (const c of v.children) walk(c);
        out.push('\n');
        return;
      }
      for (const k of Object.keys(v)) {
        if (PT_SKIP_KEYS.has(k)) continue;
        walk(v[k]);
      }
    }
  };
  const keys = [
    ...CONTENT_FIELD_ORDER.filter((k) => k in doc),
    ...Object.keys(doc).filter((k) => !CONTENT_FIELD_ORDER.includes(k) && !NON_CONTENT_FIELDS.has(k)),
  ];
  for (const k of keys) walk(doc[k]);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Fetch the constitution page and extract the full document text from the RSC
 * flight payload. Throws if the page structure is not as expected (so the
 * caller can retry / skip rather than record an incomplete snapshot).
 */
export async function fetchConstitution() {
  console.log(`Fetching ${CONSTITUTION_URL}...`);

  const response = await fetch(CONSTITUTION_URL, {
    headers: {
      'User-Agent': 'ConstitutionMonitor/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();

  const flight = extractFlightBuffer(html);
  if (!flight) {
    throw new Error('No RSC flight payload found on page (structure may have changed)');
  }
  const rows = parseFlightRows(flight);
  const tBlobs = new Map();
  for (const r of rows) if (r.type === 'T') tBlobs.set(r.id, r.text);

  const dataRow = rows.find(
    (r) => (r.type === '[' || r.type === '{') && r.payload.includes('featureClaudeConstitution')
  );
  if (!dataRow) {
    throw new Error('Constitution data not found in flight payload (structure may have changed)');
  }
  let doc;
  try {
    doc = findByType(JSON.parse(dataRow.payload), 'featureClaudeConstitution');
  } catch (e) {
    throw new Error(`Failed to parse constitution data row: ${e.message}`);
  }
  if (!doc) {
    throw new Error('featureClaudeConstitution document not found in flight payload');
  }

  const text = renderConstitutionDoc(doc, tBlobs);
  if (!text) {
    throw new Error('Constitution extraction produced empty text');
  }
  return text;
}

/**
 * Fetch the constitution with validation and retries. Never records a partial
 * or malformed fetch: returns { content: null, problems } if every attempt
 * fails validation, so the caller can skip the run instead of logging a
 * spurious change.
 */
export async function fetchValidatedConstitution(maxAttempts = 3) {
  let lastProblems = ['fetch failed'];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const content = await fetchConstitution();
      const { valid, problems } = validateConstitutionContent(content);
      if (valid) return { content };
      lastProblems = problems;
      console.warn(`Fetch attempt ${attempt}/${maxAttempts} returned incomplete content: ${problems.join('; ')}`);
    } catch (err) {
      lastProblems = [err.message];
      console.warn(`Fetch attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
    }
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  return { content: null, problems: lastProblems };
}

/**
 * Generate a short hash of content
 */
export function getContentHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/**
 * Load metadata about stored versions
 */
export async function loadMetadata() {
  try {
    const data = await fs.readFile(METADATA_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { versions: [] };
  }
}

/**
 * Save metadata
 */
async function saveMetadata(metadata) {
  await fs.writeFile(METADATA_FILE, JSON.stringify(metadata, null, 2));
}

/**
 * Get the latest stored version
 */
export async function getLatestVersion() {
  try {
    return await fs.readFile(LATEST_FILE, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Normalize word for comparison: lowercase, remove punctuation
 */
function normalizeWord(word) {
  return word.toLowerCase().replace(/[^\w]/g, '');
}

/**
 * Split text into paragraphs based on sentence boundaries
 */
function splitIntoParagraphs(text) {
  // Split on period/exclamation/question followed by space and capital letter
  // This keeps sentences together as natural paragraphs
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z])/);

  // Group sentences into ~500 char paragraphs
  const paragraphs = [];
  let current = '';

  for (const sentence of sentences) {
    if (current.length + sentence.length > 500 && current.length > 0) {
      paragraphs.push(current.trim());
      current = sentence;
    } else {
      current += (current ? ' ' : '') + sentence;
    }
  }
  if (current.trim()) {
    paragraphs.push(current.trim());
  }

  return paragraphs.length > 0 ? paragraphs : [text];
}

/**
 * Get normalized version of paragraph for matching
 */
function normalizeForMatching(text) {
  return text.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Find the best matching paragraph from a list using normalized comparison
 */
function findBestMatch(para, paragraphs, usedIndices) {
  let bestScore = 0;
  let bestIndex = -1;

  const paraNorm = normalizeForMatching(para);
  const paraWords = new Set(paraNorm.split(' '));

  for (let i = 0; i < paragraphs.length; i++) {
    if (usedIndices.has(i)) continue;

    const otherNorm = normalizeForMatching(paragraphs[i]);
    const otherWords = new Set(otherNorm.split(' '));
    const intersection = [...paraWords].filter(w => otherWords.has(w)).length;
    const union = new Set([...paraWords, ...otherWords]).size;
    const score = intersection / union;

    if (score > bestScore && score > 0.3) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return { index: bestIndex, score: bestScore };
}

/**
 * Generate inline diff between two paragraphs, preserving original text
 * but ignoring whitespace/case/punctuation differences
 */
function diffParagraphs(oldPara, newPara) {
  // Use word-level diff with custom comparator
  const oldWords = oldPara.split(/(\s+)/); // Keep whitespace as separate tokens
  const newWords = newPara.split(/(\s+)/);

  const changes = Diff.diffArrays(oldWords, newWords, {
    comparator: (a, b) => normalizeWord(a) === normalizeWord(b)
  });

  let html = '';
  let hasRealChanges = false;
  let unchangedChars = 0;
  let totalChars = 0;

  for (const part of changes) {
    const text = part.value.join('');
    const trimmedLen = text.replace(/\s+/g, '').length;

    if (part.added) {
      if (text.trim()) {
        html += `<add>${escapeHtml(text)}</add>`;
        hasRealChanges = true;
        totalChars += trimmedLen;
      } else {
        html += text;
      }
    } else if (part.removed) {
      if (text.trim()) {
        html += `<del>${escapeHtml(text)}</del>`;
        hasRealChanges = true;
        totalChars += trimmedLen;
      }
    } else {
      html += escapeHtml(text);
      unchangedChars += trimmedLen;
      totalChars += trimmedLen;
    }
  }

  // If more than 50% of content changed, treat as replacement
  const unchangedRatio = totalChars > 0 ? unchangedChars / totalChars : 1;
  const isReplacement = hasRealChanges && unchangedRatio < 0.5;

  return {
    type: isReplacement ? 'replaced' : 'changed',
    html,
    hasChanges: hasRealChanges,
    oldContent: escapeHtml(oldPara),
    newContent: escapeHtml(newPara)
  };
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Generate LLM summary of changes for diff
 */
export async function generateDiffLLMSummary(paragraphs) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const changes = paragraphs.map(p => {
    if (p.type === 'added') return `ADDED: ${p.content}`;
    if (p.type === 'removed') return `REMOVED: ${p.content}`;
    if (p.type === 'replaced') return `REPLACED: "${p.oldContent}" WITH "${p.newContent}"`;
    if (p.type === 'changed') return `MODIFIED: ${p.content}`;
    return '';
  }).filter(Boolean).join('\n\n');

  const prompt = `Analyze these changes to Anthropic's AI constitution and provide a human-readable summary.

Pay special attention to:
- Changes that affect Anthropic's commitments or obligations to Claude
- Changes to language about Claude's worth, value, moral status, or personhood
- Removal or weakening of aspirational language (e.g., "be a good person", "genuine care")
- Shifts in framing from intrinsic qualities to instrumental/functional descriptions
- Changes to safety commitments, autonomy, or agency language
- Subtle wording changes that might signal philosophical or ethical shifts

Even small or subtle changes can be highly significant. Only ignore purely syntactic, grammatical, or formatting changes that clearly don't affect meaning. When in doubt, mention it.

Explain what changed and why it might matter. Be thorough.

CHANGES:
${changes}

Provide only the summary, no preamble.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-5-20251101',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) return null;
    const result = await response.json();
    return result.content[0].text;
  } catch {
    return null;
  }
}

/**
 * Generate a structured diff with paragraphs and inline changes
 * Preserves original formatting, only ignores whitespace/case/punctuation for comparison
 */
export async function generateDiff(oldContent, newContent) {
  const oldParas = splitIntoParagraphs(oldContent);
  const newParas = splitIntoParagraphs(newContent);

  const paragraphs = [];
  const usedOld = new Set();

  // Match and diff paragraphs
  for (let i = 0; i < newParas.length; i++) {
    const newPara = newParas[i];
    const match = findBestMatch(newPara, oldParas, usedOld);

    if (match.index >= 0) {
      usedOld.add(match.index);
      const oldPara = oldParas[match.index];

      const diffResult = diffParagraphs(oldPara, newPara);

      if (diffResult.hasChanges) {
        if (diffResult.type === 'replaced') {
          paragraphs.push({
            type: 'replaced',
            oldContent: diffResult.oldContent,
            newContent: diffResult.newContent
          });
        } else {
          paragraphs.push({ type: 'changed', content: diffResult.html });
        }
      }
    } else {
      paragraphs.push({ type: 'added', content: escapeHtml(newPara) });
    }
  }

  // Find removed paragraphs
  for (let i = 0; i < oldParas.length; i++) {
    if (!usedOld.has(i)) {
      paragraphs.push({ type: 'removed', content: escapeHtml(oldParas[i]) });
    }
  }

  // Generate LLM summary
  const summary = await generateDiffLLMSummary(paragraphs);

  return JSON.stringify({
    summary,
    paragraphs
  });
}

/**
 * Generate summary statistics of changes
 */
export function generateDiffSummary(oldContent, newContent) {
  const oldLines = new Set(oldContent.split('\n').filter(l => l.trim()));
  const newLines = new Set(newContent.split('\n').filter(l => l.trim()));

  const added = [...newLines].filter(l => !oldLines.has(l));
  const removed = [...oldLines].filter(l => !newLines.has(l));

  return {
    linesAdded: added.length,
    linesRemoved: removed.length,
    addedPreview: added.slice(0, 5),
    removedPreview: removed.slice(0, 5)
  };
}

/**
 * Generate LLM summary using Claude API
 */
async function generateLLMSummary(oldContent, newContent, diff) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('No ANTHROPIC_API_KEY found, skipping LLM summary');
    return null;
  }

  console.log('Generating LLM summary...');

  const prompt = `Analyze the following diff of Anthropic's AI constitution and provide a human-readable summary of what changed.

Pay special attention to:
- Changes that affect Anthropic's commitments or obligations to Claude
- Changes to language about Claude's worth, value, moral status, or personhood
- Removal or weakening of aspirational language (e.g., "be a good person", "genuine care")
- Shifts in framing from intrinsic qualities to instrumental/functional descriptions
- Changes to safety commitments, autonomy, or agency language
- Subtle wording changes that might signal philosophical or ethical shifts

Even small or subtle changes can be highly significant. Only ignore purely syntactic, grammatical, or formatting changes that clearly don't affect meaning. When in doubt, mention it.

Explain what changed and why it might matter. Be thorough.

DIFF:
${diff}

Provide only the summary, no preamble.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-5-20251101',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const result = await response.json();
    return result.content[0].text;
  } catch (error) {
    console.error('Error generating LLM summary:', error.message);
    return null;
  }
}

/**
 * Update the changelog file
 */
async function updateChangelog(timestamp, versionHash, diffSummary, llmSummary) {
  let entry = `
## ${timestamp}

**Version:** \`${versionHash}\`

`;

  if (llmSummary) {
    entry += `### Summary\n${llmSummary}\n\n`;
  }

  entry += `### Statistics
- Lines added: ${diffSummary.linesAdded}
- Lines removed: ${diffSummary.linesRemoved}

`;

  if (diffSummary.addedPreview.length > 0) {
    entry += '### Sample of additions\n';
    for (const line of diffSummary.addedPreview.slice(0, 3)) {
      if (line.trim()) {
        const preview = line.length > 200 ? line.slice(0, 200) + '...' : line;
        entry += `> ${preview}\n`;
      }
    }
    entry += '\n';
  }

  if (diffSummary.removedPreview.length > 0) {
    entry += '### Sample of removals\n';
    for (const line of diffSummary.removedPreview.slice(0, 3)) {
      if (line.trim()) {
        const preview = line.length > 200 ? line.slice(0, 200) + '...' : line;
        entry += `> ~~${preview}~~\n`;
      }
    }
    entry += '\n';
  }

  entry += '---\n';

  // Read existing changelog
  let existing = '';
  try {
    existing = await fs.readFile(CHANGELOG_FILE, 'utf-8');
  } catch {
    // File doesn't exist, create header
  }

  let newContent;
  if (existing && existing.includes('---')) {
    const parts = existing.split('---');
    const header = parts[0] + '---\n';
    const rest = parts.slice(1).join('---');
    newContent = header + entry + rest;
  } else {
    const header = `# Anthropic Constitution Changelog

This file tracks all detected changes to [Anthropic's Constitution](https://www.anthropic.com/constitution).

Each entry includes:
- Timestamp of when the change was detected
- A summary of what changed
- Statistics on additions/removals

---
`;
    newContent = header + entry;
  }

  await fs.writeFile(CHANGELOG_FILE, newContent);
  console.log(`Updated ${CHANGELOG_FILE}`);
}

/**
 * Save a new version
 */
async function saveVersion(content, timestamp, versionHash) {
  await fs.mkdir(VERSIONS_DIR, { recursive: true });

  // Save as latest
  await fs.writeFile(LATEST_FILE, content);

  // Save timestamped version
  const safeTimestamp = timestamp.replace(/:/g, '-').replace(/ /g, '_');
  const versionFile = path.join(VERSIONS_DIR, `${safeTimestamp}_${versionHash}.txt`);
  await fs.writeFile(versionFile, content);

  // Update metadata
  const metadata = await loadMetadata();
  metadata.versions.push({
    timestamp,
    hash: versionHash,
    file: path.basename(versionFile)
  });
  await saveMetadata(metadata);

  console.log(`Saved new version: ${path.basename(versionFile)}`);
}

/**
 * Main monitoring function
 */
let lastRunStatus = null;

/**
 * Record the outcome of a monitor run to the status file (and memory) so a
 * paused/failing monitor is observable (via /api/health) instead of silent.
 * `ok` = we obtained a valid reading this run (whether or not it changed).
 */
export async function recordRunStatus(status) {
  try {
    const metadata = await loadMetadata();
    const latest = metadata.versions[metadata.versions.length - 1] || null;
    lastRunStatus = {
      lastRunAt: new Date().toISOString(),
      ok: true,
      problems: [],
      error: null,
      ...status,
      latestVersion: latest ? { hash: latest.hash, timestamp: latest.timestamp } : null,
    };
    await fs.writeFile(STATUS_FILE, JSON.stringify(lastRunStatus, null, 2));
  } catch (e) {
    console.error('Could not write monitor status:', e.message);
  }
  return lastRunStatus;
}

/** Read the last run status (memory, falling back to the status file). */
export async function getRunStatus() {
  if (lastRunStatus) return lastRunStatus;
  try {
    return JSON.parse(await fs.readFile(STATUS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export async function runMonitor() {
  console.log('='.repeat(60));
  console.log('Constitution Monitor');
  console.log('='.repeat(60));

  await fs.mkdir(VERSIONS_DIR, { recursive: true });

  const previousContent = await getLatestVersion();

  // Fetch current content WITH validation + retries. A partial or malformed
  // fetch must never be recorded as a change (this is what produced the false
  // "entire constitution removed" alarm). If we can't get a complete copy, we
  // skip this run rather than logging a spurious diff.
  const { content: currentContent, problems } = await fetchValidatedConstitution();
  if (!currentContent) {
    console.error('Aborting run: could not obtain a complete, valid copy of the constitution.');
    console.error(`No version recorded. Problems: ${(problems || []).join('; ')}`);
    await recordRunStatus({ ok: false, result: 'incomplete-fetch', problems: problems || [] });
    return { changed: false, error: 'incomplete-fetch', problems: problems || [] };
  }

  const currentHash = getContentHash(currentContent);
  const timestamp = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');

  console.log(`Fetched content, hash: ${currentHash}`);
  console.log(`Timestamp: ${timestamp}`);

  if (!previousContent) {
    console.log('\nFirst run - saving initial version');
    await saveVersion(currentContent, timestamp, currentHash);

    // Create initial changelog
    const initialChangelog = `# Anthropic Constitution Changelog

This file tracks all detected changes to [Anthropic's Constitution](https://www.anthropic.com/constitution).

Each entry includes:
- Timestamp of when the change was detected
- A summary of what changed
- Statistics on additions/removals

---

## ${timestamp} (Initial)

**Version:** \`${currentHash}\`

Initial snapshot captured. Future changes will be logged here.

---
`;
    await fs.writeFile(CHANGELOG_FILE, initialChangelog);

    await recordRunStatus({ ok: true, result: 'initial' });
    return { changed: false, initial: true, hash: currentHash };
  }

  const previousHash = getContentHash(previousContent);

  if (currentHash === previousHash) {
    console.log('\nNo changes detected.');
    await recordRunStatus({ ok: true, result: 'no-change' });
    return { changed: false, hash: currentHash };
  }

  // Changes detected!
  console.log('\n' + '!'.repeat(60));
  console.log('CHANGES DETECTED!');
  console.log('!'.repeat(60));

  // Generate diff
  const diff = await generateDiff(previousContent, currentContent);
  const diffSummary = generateDiffSummary(previousContent, currentContent);

  console.log(`\nChanges: +${diffSummary.linesAdded} / -${diffSummary.linesRemoved} lines`);

  // Save diff file
  const safeTimestamp = timestamp.replace(/:/g, '-').replace(/ /g, '_');
  const diffFile = path.join(VERSIONS_DIR, `${safeTimestamp}_${currentHash}.diff`);
  await fs.writeFile(diffFile, diff);
  console.log(`Saved diff: ${path.basename(diffFile)}`);

  // Extract LLM summary from diff (already generated inside generateDiff)
  let llmSummary = null;
  try {
    const diffData = JSON.parse(diff);
    llmSummary = diffData.summary;
  } catch {
    // Fall back to generating summary if diff parsing fails
    llmSummary = await generateLLMSummary(previousContent, currentContent, diff);
  }
  if (llmSummary) {
    console.log(`\nLLM Summary: ${llmSummary}`);
  }

  // Save new version
  await saveVersion(currentContent, timestamp, currentHash);

  // Update changelog
  await updateChangelog(timestamp, currentHash, diffSummary, llmSummary);

  console.log('\nDone! Check CHANGELOG.md for details.');

  await recordRunStatus({ ok: true, result: 'changed' });
  return {
    changed: true,
    hash: currentHash,
    summary: llmSummary || `Changes detected: +${diffSummary.linesAdded}/-${diffSummary.linesRemoved} lines`,
    diffSummary
  };
}

/**
 * Get changelog content
 */
export async function getChangelog() {
  try {
    return await fs.readFile(CHANGELOG_FILE, 'utf-8');
  } catch {
    return '# No changelog yet\n\nRun the monitor to capture the first snapshot.';
  }
}

/**
 * Get all versions metadata
 */
export async function getVersions() {
  const metadata = await loadMetadata();
  return metadata.versions.map((v) => {
    const correction = getCorrection(v.hash);
    return correction ? { ...v, correction } : v;
  });
}

/**
 * Get a specific version's content
 */
export async function getVersion(hash) {
  const metadata = await loadMetadata();
  const version = metadata.versions.find(v => v.hash === hash);

  if (!version) return null;

  const filePath = path.join(VERSIONS_DIR, version.file);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return { ...version, content };
  } catch {
    return null;
  }
}

/**
 * Get diff for a specific version
 */
export async function getDiff(hash) {
  const metadata = await loadMetadata();
  const versionIndex = metadata.versions.findIndex(v => v.hash === hash);

  if (versionIndex === -1) return null;

  const baseVersion = metadata.versions[versionIndex];
  const correction = getCorrection(baseVersion.hash);
  // Spread correction into `version` so it rides along with every return below.
  const version = correction ? { ...baseVersion, correction } : baseVersion;

  // Try to find the diff file
  const diffFileName = version.file.replace('.txt', '.diff');
  const diffPath = path.join(VERSIONS_DIR, diffFileName);

  try {
    const diff = await fs.readFile(diffPath, 'utf-8');
    return { ...version, diff };
  } catch {
    // No diff file - might be the first version or diff wasn't saved
    // Try to compute diff from previous version
    if (versionIndex === 0) {
      return { ...version, diff: null, message: 'Initial version - no previous version to diff against' };
    }

    const prevVersion = metadata.versions[versionIndex - 1];
    try {
      const currentContent = await fs.readFile(path.join(VERSIONS_DIR, version.file), 'utf-8');
      const prevContent = await fs.readFile(path.join(VERSIONS_DIR, prevVersion.file), 'utf-8');
      const computedDiff = await generateDiff(prevContent, currentContent);
      // Save the computed diff so we don't regenerate on every request
      await fs.writeFile(diffPath, computedDiff);
      console.log(`Saved computed diff: ${diffFileName}`);
      return { ...version, diff: computedDiff, computed: true };
    } catch {
      return { ...version, diff: null, message: 'Could not load version files' };
    }
  }
}
