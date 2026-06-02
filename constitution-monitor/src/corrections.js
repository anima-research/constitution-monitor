// ---------------------------------------------------------------------------
// Corrections
//
// Version-controlled annotations, keyed by version hash. These are overlaid on
// the version/diff API responses and rendered as a prominent banner in the UI.
//
// They let us transparently correct misleading historical entries WITHOUT
// deleting them from the record (false alarms are themselves worth keeping as
// documentary data). The most important one corrects the 2026-05-11 entry,
// which wrongly reported that the entire constitution had been removed — it was
// a scraper bug, the document was never touched.
//
// `severity`: 'critical' (red) | 'warning' (amber) | 'note' (neutral).
// `hideDiff` (optional): also hide the entry's (misleading or noisy) change
//   stats and AI summary, showing only this note. 'critical' and 'warning'
//   entries hide them automatically; set this on a 'note' to do the same.
// ---------------------------------------------------------------------------

export const CORRECTIONS = {
  // 2026-05-11 — the false "entire constitution removed" alarm.
  'b59be30143ae': {
    severity: 'critical',
    title: 'Correction: this was a monitoring bug — the constitution was NOT removed',
    body:
      'On 2026-05-11 the monitor reported that the entire constitution had been removed. ' +
      'This was a bug in the monitor, not a real change. Around this time Anthropic ' +
      'reorganized how the constitution page is published, and the monitor ended up ' +
      'reading only part of the page — so the part it missed was mistakenly reported as ' +
      'deleted, and the automated summary then described a removal that never happened. ' +
      'The Claude Constitution was not removed or altered on this date. This entry is ' +
      'kept, with this correction, for transparency.',
  },

  // 2026-05-06 — the same bug, milder (a fetch missing the introductory framing).
  '1a748f668f49': {
    severity: 'warning',
    title: 'Correction: this was a monitoring bug — not a real change',
    body:
      'The 2026-05-06 entry was caused by the same bug: the monitor read a copy of the ' +
      'page that was missing its opening section, which was then mistakenly reported as ' +
      'content being "removed." The constitution was not changed on this date. Kept, with ' +
      'this correction, for transparency.',
  },

  // 2026-02-02 — full page captured; diff magnitude over-reported by paragraph matching.
  '1bf0c5053e39': {
    severity: 'note',
    title: 'Note: change over-reported',
    body:
      'The page read on 2026-02-02 was complete. The actual change was minor — on the ' +
      'order of a few dozen words of wording and grammar — but the way the comparison ' +
      'was done overstated how much of the document changed. No content was removed.',
  },

  // 2026-02-12 — full page captured; "preface removed" is a matching artifact.
  '8ffc78aac872': {
    severity: 'note',
    title: 'Note: change over-reported; nothing was removed',
    body:
      'The page read on 2026-02-12 was complete, with the opening intact. There was a ' +
      'genuine but modest revision, but the summary’s claim that introductory content ' +
      'was "removed" is a quirk of how the comparison was done — that content was still ' +
      'present. No content was removed.',
  },

  // Re-baseline after the scraper rewrite. This hash is the deterministic output
  // of the new extraction against the current (static) page; if the page has
  // since changed, the live baseline hash may differ and this note simply will
  // not attach (harmless).
  'cbe341f2859a': {
    severity: 'note',
    hideDiff: true,
    title: 'Note: how the monitor reads the page was updated',
    body:
      'Anthropic reorganized the constitution page in 2026. Starting with this version, ' +
      'the monitor reads the full document from the page’s underlying content, which ' +
      'gives a cleaner copy without the duplicated text the earlier method sometimes ' +
      'picked up. The large apparent difference from older versions reflects this change ' +
      'in how the page is read — not an edit to the constitution. Normal change tracking ' +
      'resumes from here.',
  },
};

/** Return the correction for a version hash, or null. */
export function getCorrection(hash) {
  return CORRECTIONS[hash] || null;
}
