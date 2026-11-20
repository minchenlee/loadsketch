const NUM_UNIT =
  /(?:\b\d+(?:\.\d+)?%?\s+(?:(?:(?:requests|reads|writes)(?:\/s)?|(?:request|read|write)\/s|ms|s|servers?|slots?|connections?|messages?|minutes?|rounds?|times?|uploads?|retries|busy|at a time|a second)\b|(?:個請求|個槽|條連線|次讀取|次寫入|分鐘|忙碌|在忙|[台個秒輪則倍條次分]))|(?:超過|more than)\s+\d+(?:\.\d+)?\b)/g;

export interface CalcPart {
  text: string;
  nowrap: boolean;
}

/** Split an arithmetic line into runs, marking `<number> <unit>` pairs `nowrap` so line breaks never split them. */
export function calcParts(line: string): CalcPart[] {
  const parts: CalcPart[] = [];
  let last = 0;
  for (const m of line.matchAll(NUM_UNIT)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ text: line.slice(last, at), nowrap: false });
    parts.push({ text: m[0], nowrap: true });
    last = at + m[0].length;
  }
  if (last === 0) return [{ text: line, nowrap: false }];
  if (last < line.length) parts.push({ text: line.slice(last), nowrap: false });
  return parts;
}
