function diff(cachedKeys, entries) {
  const cachedSet = new Set(cachedKeys);
  const newKeySet = new Set(entries.map(e => e.key).filter(k => k !== null));
  const addedKeys = [...newKeySet].filter(k => !cachedSet.has(k));
  const removedKeys = [...cachedSet].filter(k => !newKeySet.has(k));
  return { addedKeys, removedKeys, newKeys: [...newKeySet] };
}

// Safety valve from the spec: when more than half the page changed (redesign,
// scraper glitch, corrupt cache), fall back to full-page extraction.
function isDiffTooLarge(addedKeys, removedKeys, cachedCount, newCount) {
  const denominator = Math.max(cachedCount, newCount);
  if (denominator === 0) return true;
  return (addedKeys.length + removedKeys.length) / denominator > 0.5;
}

// Excerpts sent to the AI: ±window lines around every added line, overlapping
// or adjacent windows merged, original text preserved (digits intact — noise
// lines are cheap and give the model context for split tender rows).
function buildChunks(entries, addedKeys, window = 3) {
  const addedSet = new Set(addedKeys);
  const ranges = [];
  entries.forEach((e, i) => {
    if (e.key === null || !addedSet.has(e.key)) return;
    const start = Math.max(0, i - window);
    const end = Math.min(entries.length - 1, i + window);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  });
  return ranges.map(r => entries.slice(r.start, r.end + 1).map(e => e.line).join('\n'));
}

module.exports = { diff, isDiffTooLarge, buildChunks };
