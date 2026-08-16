export interface TextRangeEdit {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
}

export function applyTextRangeEdits(
  content: string,
  edits: readonly TextRangeEdit[]
): string {
  const withOffsets = edits.map((edit, index) => {
    const start = positionToOffset(
      content,
      edit.startLine,
      edit.startColumn
    );
    const end = positionToOffset(content, edit.endLine, edit.endColumn);
    if (end < start) {
      throw new RangeError(`Edit ${index} ends before it starts.`);
    }
    return { edit, start, end, index };
  });

  withOffsets.sort((left, right) => {
    if (left.start !== right.start) {
      return right.start - left.start;
    }
    return right.end - left.end;
  });

  for (let index = 1; index < withOffsets.length; index += 1) {
    const previous = withOffsets[index - 1]!;
    const current = withOffsets[index]!;
    if (current.end > previous.start) {
      throw new RangeError(
        `Edits ${current.index} and ${previous.index} overlap.`
      );
    }
  }

  let result = content;
  for (const { edit, start, end } of withOffsets) {
    result = result.slice(0, start) + edit.text + result.slice(end);
  }
  return result;
}

function positionToOffset(
  content: string,
  oneBasedLine: number,
  oneBasedColumn: number
): number {
  if (
    !Number.isInteger(oneBasedLine) ||
    !Number.isInteger(oneBasedColumn) ||
    oneBasedLine < 1 ||
    oneBasedColumn < 1
  ) {
    throw new RangeError("Line and column values must be positive integers.");
  }
  const lines = content.split("\n");
  if (oneBasedLine > lines.length) {
    throw new RangeError(`Line ${oneBasedLine} is outside the document.`);
  }
  const line = lines[oneBasedLine - 1]!;
  const zeroBasedColumn = oneBasedColumn - 1;
  if (zeroBasedColumn > line.length) {
    throw new RangeError(
      `Column ${oneBasedColumn} is outside line ${oneBasedLine}.`
    );
  }
  let offset = zeroBasedColumn;
  for (let index = 0; index < oneBasedLine - 1; index += 1) {
    offset += lines[index]!.length + 1;
  }
  return offset;
}
