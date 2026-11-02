// COVERAGE MATH THAT CAN BE TESTED WITHOUT RUNNING THE BATTERY.
//
// V8 gives every process its own function/range map. A module loaded by the parent check process can have a
// zero-count range while a child process executed the same range; taking the first range with equal boundaries
// throws the child's count away. Merge equal ranges by summing counts before choosing the innermost range for a
// line. The line is covered when that merged count is positive.

const validRange = (range) => range
  && Number.isFinite(range.startOffset) && Number.isFinite(range.endOffset)
  && range.startOffset >= 0 && range.endOffset >= range.startOffset;

export function mergeRanges(groups) {
  const merged = new Map();
  for (const ranges of groups) {
    for (const range of ranges || []) {
      if (!validRange(range)) continue;
      const key = range.startOffset + ":" + range.endOffset;
      const count = Number.isFinite(range.count) ? range.count : 0;
      const previous = merged.get(key);
      if (previous) previous.count += count;
      else merged.set(key, { startOffset: range.startOffset, endOffset: range.endOffset, count });
    }
  }
  return [...merged.values()];
}

export function lineCoverage(text, ranges) {
  const merged = mergeRanges([ranges]);
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") starts.push(i + 1);
  let lines = 0;
  let covered = 0;
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : text.length + 1;
    const touching = merged.filter((range) => range.startOffset < end && range.endOffset > start);
    if (!touching.length) continue; // comments, blank lines and declarations with no executable range
    lines += 1;
    // V8 ranges are nested: the module/top-level range covers the whole file and would paint an uncalled function
    // as covered. The shortest containing range describes the line; equal boundaries are one range after merging.
    const innermost = touching.reduce((best, range) => (
      range.endOffset - range.startOffset < best.endOffset - best.startOffset ? range : best
    ));
    if (innermost.count > 0) covered += 1;
  }
  return { lines, covered, percent: lines ? Number(((covered / lines) * 100).toFixed(1)) : 100 };
}
