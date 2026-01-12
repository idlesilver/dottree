import * as vscode from "vscode";

type Style = "unicode" | "ascii";

type NodeLine = {
  lineNo: number;
  depth: number;       // nesting level
  text: string;        // payload after prefixes
};

let isApplyingEdit = false;

function getConfigStyle(): Style {
  const cfg = vscode.workspace.getConfiguration("dottree");
  return (cfg.get<string>("style", "unicode") as Style) ?? "unicode";
}

function indentSubtreeOnSingleCursor(): boolean {
  const cfg = vscode.workspace.getConfiguration("dottree");
  return cfg.get<boolean>("indentSubtreeOnSingleCursor", true) ?? true;
}

// Detect if a line looks like a tree line (unicode or ascii-ish)
function isTreeLine(line: string): boolean {
  const s = line.trimEnd();
  if (!s) return false;
  return (
    /[├└│]/.test(s) ||                // unicode box-drawing
    /^(\|  )*(\+--|`--)(\s|$)/.test(s) || // common ascii tree
    /^(\s{3})*(\+--|`--)(\s|$)/.test(s)
  );
}

// Parse a line to (depth, text). We accept both unicode & ascii formats.
function parseLine(line: string): { depth: number; text: string } | null {
  const raw = line.replace(/\t/g, "  "); // keep simple
  const trimmedRight = raw.replace(/\s+$/, "");
  if (!trimmedRight) return null;

  // Unicode style: each ancestor level is either "│  " or "   "
  // Then branch is "├─" or "└─" (also accept "├──"/"└──"), text optional.
  const uni = /^((?:│  |   )*)([├└])─{1,2}(?:\s(.*))?$/u.exec(trimmedRight);
  if (uni) {
    const prefix = uni[1] ?? "";
    const text = (uni[3] ?? "").trimEnd();
    const depth = Math.floor(prefix.length / 3);
    return { depth, text };
  }

  // ASCII: ancestor levels often "|  " or "   ", branch "+--" or "`--", text optional.
  const ascii = /^((?:(?:\|  |   )*))(\+--|`--)(?:\s(.*))?$/.exec(trimmedRight);
  if (ascii) {
    const prefix = ascii[1] ?? "";
    const text = (ascii[3] ?? "").trimEnd();
    const depth = Math.floor(prefix.length / 3);
    return { depth, text };
  }

  return null;
}

function buildLine(depth: number, text: string, isLast: boolean, ancestorLast: boolean[], style: Style): string {
  const pieces: string[] = [];

  for (let i = 0; i < depth; i++) {
    // For each ancestor level, choose vertical continuation or blank
    const lastAtThisAncestor = ancestorLast[i] ?? false;
    if (style === "unicode") {
      pieces.push(lastAtThisAncestor ? "   " : "│  ");
    } else {
      pieces.push(lastAtThisAncestor ? "   " : "|  ");
    }
  }

  // Branch marker for current line
  if (style === "unicode") {
    pieces.push(isLast ? "└─ " : "├─ ");
  } else {
    pieces.push(isLast ? "`-- " : "+-- ");
  }

  pieces.push(text);
  return pieces.join("");
}

// Determine last-sibling flags by looking ahead to the next line with depth <= current depth
function computeIsLast(nodes: NodeLine[]): boolean[] {
  const isLast = new Array(nodes.length).fill(false);
  for (let i = 0; i < nodes.length; i++) {
    const d = nodes[i].depth;
    let last = true;
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[j].depth < d) break;        // parent/super-sibling encountered -> no more siblings
      if (nodes[j].depth === d) { last = false; break; } // found a sibling after me
    }
    isLast[i] = last;
  }
  return isLast;
}

function formatNodes(nodes: NodeLine[], style: Style): string[] {
  const isLast = computeIsLast(nodes);
  const lines: string[] = [];
  const lastAtDepth: { isLast: boolean }[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const d = nodes[i].depth;
    lastAtDepth.length = d;
    const ancestorLast = lastAtDepth.map(x => x.isLast);
    lines.push(buildLine(d, nodes[i].text, isLast[i], ancestorLast, style));
    lastAtDepth[d] = { isLast: isLast[i] };
  }

  return lines;
}

// Expand to a contiguous "tree block" around a given line
function findTreeBlock(doc: vscode.TextDocument, aroundLine: number): { start: number; end: number } | null {
  const n = doc.lineCount;
  if (aroundLine < 0 || aroundLine >= n) return null;
  if (!isTreeLine(doc.lineAt(aroundLine).text)) return null;

  let start = aroundLine;
  while (start - 1 >= 0 && isTreeLine(doc.lineAt(start - 1).text)) start--;

  let end = aroundLine;
  while (end + 1 < n && isTreeLine(doc.lineAt(end + 1).text)) end++;

  return { start, end };
}

function parseBlock(doc: vscode.TextDocument, start: number, end: number): NodeLine[] {
  const nodes: NodeLine[] = [];
  for (let ln = start; ln <= end; ln++) {
    const parsed = parseLine(doc.lineAt(ln).text);
    if (!parsed) continue; // skip non-parseable (shouldn't happen if isTreeLine is true, but safe)
    nodes.push({ lineNo: ln, depth: parsed.depth, text: parsed.text });
  }
  return nodes;
}

function getTreeLineColumns(line: string): { markerEnd: number; payloadStart: number } | null {
  const raw = line;
  const trimmedRight = raw.replace(/\s+$/, "");
  if (!trimmedRight) return null;

  const uni = /^((?:│  |   )*)([├└]─{1,2})(.*)$/u.exec(trimmedRight);
  if (uni) {
    const prefixLen = (uni[1] ?? "").length;
    const markerLen = (uni[2] ?? "").length;
    const markerEnd = prefixLen + markerLen;
    let payloadStart = markerEnd;
    while (raw[payloadStart] === " ") payloadStart++;
    return { markerEnd, payloadStart };
  }

  const ascii = /^((?:(?:\|  |   )*))(\+--|`--)(.*)$/.exec(trimmedRight);
  if (ascii) {
    const prefixLen = (ascii[1] ?? "").length;
    const markerLen = (ascii[2] ?? "").length;
    const markerEnd = prefixLen + markerLen;
    let payloadStart = markerEnd;
    while (raw[payloadStart] === " ") payloadStart++;
    return { markerEnd, payloadStart };
  }

  return null;
}

function computeIsLeaf(nodes: NodeLine[]): boolean[] {
  const isLeaf = new Array(nodes.length).fill(true);
  for (let i = 0; i < nodes.length; i++) {
    if (i + 1 < nodes.length && nodes[i + 1].depth > nodes[i].depth) {
      isLeaf[i] = false;
    }
  }
  return isLeaf;
}

type DecorationBuckets = { prefixes: vscode.Range[]; folders: vscode.Range[]; files: vscode.Range[] };

function isTreeDocument(doc: vscode.TextDocument): boolean {
  if (doc.languageId === "tree") return true;
  return doc.fileName.toLowerCase().endsWith(".tree");
}

function isMarkdownDocument(doc: vscode.TextDocument): boolean {
  return doc.languageId === "markdown";
}

function addDecorationsForBlock(
  doc: vscode.TextDocument,
  blockStart: number,
  blockEnd: number,
  buckets: DecorationBuckets
) {
  const nodes = parseBlock(doc, blockStart, blockEnd);
  const isLeaf = computeIsLeaf(nodes);
  const lineTextCache = new Map<number, string>();

  for (let i = 0; i < nodes.length; i++) {
    const ln = nodes[i].lineNo;
    const lineText = lineTextCache.get(ln) ?? doc.lineAt(ln).text;
    lineTextCache.set(ln, lineText);

    const cols = getTreeLineColumns(lineText);
    if (!cols) continue;

    const trimmedRightLen = lineText.replace(/\s+$/, "").length;
    const prefixEnd = Math.min(cols.payloadStart, lineText.length);
    if (prefixEnd > 0) {
      buckets.prefixes.push(new vscode.Range(ln, 0, ln, prefixEnd));
    }

    let nameEnd = trimmedRightLen;
    const commentStart = lineText.indexOf("#", cols.payloadStart);
    if (commentStart >= cols.payloadStart && commentStart < trimmedRightLen) {
      nameEnd = commentStart;
    }
    while (nameEnd > cols.payloadStart && lineText[nameEnd - 1] === " ") nameEnd--;

    const name = lineText.slice(cols.payloadStart, nameEnd).trimEnd();
    if (!name) continue;

    if (nameEnd > cols.payloadStart) {
      const start = cols.payloadStart;
      const end = Math.min(nameEnd, lineText.length);
      const length = Math.max(0, end - start);
      if (length > 0) {
        const isFolder = !isLeaf[i] || name.endsWith("/");
        const range = new vscode.Range(ln, start, ln, start + length);
        if (isFolder) buckets.folders.push(range);
        else buckets.files.push(range);
      }
    }
  }
}

function collectTreeDecorations(doc: vscode.TextDocument): DecorationBuckets {
  const buckets: DecorationBuckets = { prefixes: [], folders: [], files: [] };

  let line = 0;
  while (line < doc.lineCount) {
    if (!isTreeLine(doc.lineAt(line).text)) {
      line++;
      continue;
    }

    const block = findTreeBlock(doc, line);
    if (!block) {
      line++;
      continue;
    }

    addDecorationsForBlock(doc, block.start, block.end, buckets);
    line = block.end + 1;
  }

  return buckets;
}

function collectTreeDecorationsInRange(
  doc: vscode.TextDocument,
  startLine: number,
  endLine: number,
  buckets: DecorationBuckets
) {
  let line = startLine;
  while (line <= endLine) {
    if (!isTreeLine(doc.lineAt(line).text)) {
      line++;
      continue;
    }

    const blockStart = line;
    while (line <= endLine && isTreeLine(doc.lineAt(line).text)) line++;
    const blockEnd = line - 1;

    addDecorationsForBlock(doc, blockStart, blockEnd, buckets);
  }
}

function collectTreeDecorationsForMarkdown(doc: vscode.TextDocument): DecorationBuckets {
  const buckets: DecorationBuckets = { prefixes: [], folders: [], files: [] };
  let line = 0;
  while (line < doc.lineCount) {
    const text = doc.lineAt(line).text;
    const fenceMatch = /^(\s*)(```+|~~~+)\s*([^\s`~]+)?\s*$/.exec(text);
    if (!fenceMatch) {
      line++;
      continue;
    }

    const fence = fenceMatch[2];
    const lang = (fenceMatch[3] ?? "").toLowerCase();
    if (lang !== "tree") {
      line++;
      continue;
    }

    const fenceChar = fence[0];
    const fenceLen = fence.length;
    const closeRe = new RegExp(`^\\s*${fenceChar}{${fenceLen},}\\s*$`);
    const startLine = line + 1;
    line++;
    while (line < doc.lineCount && !closeRe.test(doc.lineAt(line).text)) {
      line++;
    }
    const endLine = line - 1;
    if (endLine >= startLine) {
      collectTreeDecorationsInRange(doc, startLine, endLine, buckets);
    }
    line++;
  }

  return buckets;
}

async function normalizeTreeBlock(doc: vscode.TextDocument, block: { start: number; end: number }) {
  const nodes = parseBlock(doc, block.start, block.end);
  if (nodes.length === 0) return;

  const style = getConfigStyle();
  const formatted = formatNodes(nodes, style);
  const outLines = new Map<number, string>();
  for (let i = 0; i < nodes.length; i++) {
    outLines.set(nodes[i].lineNo, formatted[i]);
  }

  let needsEdit = false;
  for (let ln = block.start; ln <= block.end; ln++) {
    if (!outLines.has(ln)) continue;
    if (doc.lineAt(ln).text !== outLines.get(ln)) {
      needsEdit = true;
      break;
    }
  }
  if (!needsEdit) return;

  const edit = new vscode.WorkspaceEdit();
  for (let ln = block.start; ln <= block.end; ln++) {
    if (!outLines.has(ln)) continue;
    const range = doc.lineAt(ln).range;
    edit.replace(doc.uri, range, outLines.get(ln)!);
  }
  isApplyingEdit = true;
  try {
    await vscode.workspace.applyEdit(edit);
  } finally {
    isApplyingEdit = false;
  }
}

// Given cursor line index within nodes, returns [i, j] indices for subtree range
function subtreeRange(nodes: NodeLine[], i: number): { i0: number; i1: number } {
  const baseDepth = nodes[i].depth;
  let j = i;
  while (j + 1 < nodes.length && nodes[j + 1].depth > baseDepth) j++;
  return { i0: i, i1: j };
}

async function indentOrOutdent(editor: vscode.TextEditor, delta: number) {
  const doc = editor.document;
  const sel = editor.selection;

  const around = sel.active.line;
  const block = findTreeBlock(doc, around);
  if (!block) {
    // fallback to normal tab behavior when not on a tree line
    await vscode.commands.executeCommand(delta > 0 ? "tab" : "outdent");
    return;
  }

  const nodes = parseBlock(doc, block.start, block.end);
  if (nodes.length === 0) return;

  const style = getConfigStyle();

  // Map document line -> node index
  const lineToIdx = new Map<number, number>();
  nodes.forEach((n, idx) => lineToIdx.set(n.lineNo, idx));

  // Determine which node indices to shift
  const targets = new Set<number>();

  const hasSelection =
    !(sel.isEmpty) &&
    (sel.start.line !== sel.end.line || sel.start.character !== sel.end.character);

  if (hasSelection) {
    // Indent/outdent selected nodes and their subtrees
    const a = Math.min(sel.start.line, sel.end.line);
    const b = Math.max(sel.start.line, sel.end.line);
    const selectedIdx: number[] = [];
    for (let ln = a; ln <= b; ln++) {
      const idx = lineToIdx.get(ln);
      if (idx !== undefined) selectedIdx.push(idx);
    }
    for (const idx of selectedIdx) {
      const { i0, i1 } = subtreeRange(nodes, idx);
      for (let k = i0; k <= i1; k++) targets.add(k);
    }
  } else {
    // Single cursor: indent/outdent current line, optionally include its subtree
    const idx = lineToIdx.get(sel.active.line);
    if (idx === undefined) return;
    if (indentSubtreeOnSingleCursor()) {
      const { i0, i1 } = subtreeRange(nodes, idx);
      for (let k = i0; k <= i1; k++) targets.add(k);
    } else {
      targets.add(idx);
    }
  }

  // Apply depth delta (clamp at 0). Prevent depth jumps when indenting.
  if (delta > 0) {
    const applyIndent = new Array(nodes.length).fill(false);
    for (const idx of targets) applyIndent[idx] = true;

    const proposed: number[] = new Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      const prevDepth = i === 0 ? -1 : proposed[i - 1];
      let nextDepth = nodes[i].depth + (applyIndent[i] ? delta : 0);
      if (applyIndent[i] && nextDepth > prevDepth + 1) {
        applyIndent[i] = false;
        nextDepth = nodes[i].depth;
      }
      proposed[i] = nextDepth;
    }

    for (let i = 0; i < nodes.length; i++) {
      if (applyIndent[i]) nodes[i].depth = proposed[i];
    }
  } else {
    for (const idx of targets) {
      nodes[idx].depth = Math.max(0, nodes[idx].depth + delta);
    }
  }

  // After depth change, we normalize *all* lines in this tree block
  const formatted = formatNodes(nodes, style);
  const outLines = new Map<number, string>();
  for (let i = 0; i < nodes.length; i++) {
    outLines.set(nodes[i].lineNo, formatted[i]);
  }

  // Apply edit as a single workspace edit (replace exact lines)
  const edit = new vscode.WorkspaceEdit();
  for (let ln = block.start; ln <= block.end; ln++) {
    if (!outLines.has(ln)) continue;
    const range = doc.lineAt(ln).range;
    edit.replace(doc.uri, range, outLines.get(ln)!);
  }
  isApplyingEdit = true;
  try {
    await vscode.workspace.applyEdit(edit);
  } finally {
    isApplyingEdit = false;
  }
}

async function insertSiblingLine(editor: vscode.TextEditor) {
  const doc = editor.document;
  const sel = editor.selection;
  if (!sel.isEmpty) {
    await vscode.commands.executeCommand("type", { text: "\n" });
    return;
  }

  const around = sel.active.line;
  const block = findTreeBlock(doc, around);
  if (!block) {
    await vscode.commands.executeCommand("type", { text: "\n" });
    return;
  }

  const nodes = parseBlock(doc, block.start, block.end);
  if (nodes.length === 0) return;

  const treeCols = getTreeLineColumns(doc.lineAt(around).text);
  if (treeCols && sel.active.character >= treeCols.markerEnd && sel.active.character <= treeCols.payloadStart) {
    const lineToIdx = new Map<number, number>();
    nodes.forEach((n, idx) => lineToIdx.set(n.lineNo, idx));

    const idx = lineToIdx.get(around);
    if (idx === undefined) {
      await vscode.commands.executeCommand("type", { text: "\n" });
      return;
    }

    const insertIndex = idx;
    nodes.splice(insertIndex, 0, { lineNo: -1, depth: nodes[idx].depth, text: "" });

    const style = getConfigStyle();
    const formatted = formatNodes(nodes, style);

    const startPos = doc.lineAt(block.start).range.start;
    const endLine = doc.lineAt(block.end);
    const endHasLineBreak = !endLine.rangeIncludingLineBreak.end.isEqual(endLine.range.end);
    const replaceRange = new vscode.Range(startPos, endLine.rangeIncludingLineBreak.end);

    const eol = doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    let newText = formatted.join(eol);
    if (endHasLineBreak) newText += eol;

    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, replaceRange, newText);
    isApplyingEdit = true;
    try {
      await vscode.workspace.applyEdit(edit);
    } finally {
      isApplyingEdit = false;
    }

    const newLineNo = block.start + insertIndex;
    const newLine = editor.document.lineAt(newLineNo);
    const pos = new vscode.Position(newLineNo, newLine.text.length);
    editor.selection = new vscode.Selection(pos, pos);
    return;
  }

  const lineToIdx = new Map<number, number>();
  nodes.forEach((n, idx) => lineToIdx.set(n.lineNo, idx));

  const idx = lineToIdx.get(around);
  if (idx === undefined) {
    await vscode.commands.executeCommand("type", { text: "\n" });
    return;
  }

  const { i1 } = subtreeRange(nodes, idx);
  const insertIndex = i1 + 1;
  nodes.splice(insertIndex, 0, { lineNo: -1, depth: nodes[idx].depth, text: "" });

  const style = getConfigStyle();
  const formatted = formatNodes(nodes, style);

  const startPos = doc.lineAt(block.start).range.start;
  const endLine = doc.lineAt(block.end);
  const endHasLineBreak = !endLine.rangeIncludingLineBreak.end.isEqual(endLine.range.end);
  const replaceRange = new vscode.Range(startPos, endLine.rangeIncludingLineBreak.end);

  const eol = doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
  let newText = formatted.join(eol);
  if (endHasLineBreak) newText += eol;

  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, replaceRange, newText);
  isApplyingEdit = true;
  try {
    await vscode.workspace.applyEdit(edit);
  } finally {
    isApplyingEdit = false;
  }

  const newLineNo = block.start + insertIndex;
  const newLine = editor.document.lineAt(newLineNo);
  const pos = new vscode.Position(newLineNo, newLine.text.length);
  editor.selection = new vscode.Selection(pos, pos);
}

function getTreeSnippetCompletion(
  document: vscode.TextDocument,
  position: vscode.Position
): vscode.CompletionItem[] | undefined {
  const line = document.lineAt(position.line);
  if (line.text.trim() !== "|") return;
  const before = line.text.slice(0, position.character);
  if (!before.endsWith("|")) return;

  const indent = line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
  const snippet = new vscode.SnippetString(`${indent}./\n${indent}└─ README.md`);

  const item = new vscode.CompletionItem("dottree template", vscode.CompletionItemKind.Snippet);
  item.detail = "dottree";
  item.insertText = snippet;
  item.filterText = "|";
  item.sortText = "\u0000dottree";
  item.range = line.range;
  return [item];
}

function buildTreeFoldingRanges(doc: vscode.TextDocument): vscode.FoldingRange[] {
  const ranges: vscode.FoldingRange[] = [];
  let line = 0;
  while (line < doc.lineCount) {
    if (!isTreeLine(doc.lineAt(line).text)) {
      line++;
      continue;
    }

    const block = findTreeBlock(doc, line);
    if (!block) {
      line++;
      continue;
    }

    const nodes = parseBlock(doc, block.start, block.end);
    if (nodes.length === 0) {
      line = block.end + 1;
      continue;
    }

    const lineToIdx = new Map<number, number>();
    nodes.forEach((n, idx) => lineToIdx.set(n.lineNo, idx));

    for (let i = 0; i < nodes.length; i++) {
      const { i1 } = subtreeRange(nodes, i);
      if (i1 <= i) continue;
      const start = nodes[i].lineNo;
      const end = nodes[i1].lineNo;
      if (end > start) {
        ranges.push(new vscode.FoldingRange(start, end));
      }
    }

    line = block.end + 1;
  }

  return ranges;
}

export function activate(context: vscode.ExtensionContext) {
  const docLineCounts = new Map<string, number>();
  const prefixDecoration = vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor("editorWhitespace.foreground"),
  });
  const folderDecoration = vscode.window.createTextEditorDecorationType({
    color: "#F2994A",
    fontWeight: "bold",
  });
  const fileDecoration = vscode.window.createTextEditorDecorationType({
    color: "#ffffff",
  });

  const updateDecorations = (editor?: vscode.TextEditor) => {
    const active = editor ?? vscode.window.activeTextEditor;
    if (!active) return;
    if (!isTreeDocument(active.document) && !isMarkdownDocument(active.document)) {
      active.setDecorations(prefixDecoration, []);
      active.setDecorations(folderDecoration, []);
      active.setDecorations(fileDecoration, []);
      return;
    }
    const { prefixes, folders, files } = isMarkdownDocument(active.document)
      ? collectTreeDecorationsForMarkdown(active.document)
      : collectTreeDecorations(active.document);
    active.setDecorations(prefixDecoration, prefixes);
    active.setDecorations(folderDecoration, folders);
    active.setDecorations(fileDecoration, files);
  };

  // Update context key so Tab/Shift+Tab only override on tree lines
  const updateContext = (editor?: vscode.TextEditor) => {
    if (!editor) editor = vscode.window.activeTextEditor;
    const doc = editor?.document;
    if (!editor || !doc) return;

    const line = editor.selection.active.line;
    const active = line >= 0 && line < doc.lineCount && isTreeLine(doc.lineAt(line).text);
    vscode.commands.executeCommand("setContext", "dottree.activeTreeLine", active);
    docLineCounts.set(doc.uri.toString(), doc.lineCount);
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      updateContext(editor);
      updateDecorations(editor);
    }),
    vscode.window.onDidChangeTextEditorSelection(() => updateContext()),
    vscode.workspace.onDidChangeTextDocument(async (e) => {
      updateContext();
      updateDecorations(vscode.window.activeTextEditor);
      if (isApplyingEdit) return;

      const docKey = e.document.uri.toString();
      const prevLineCount = docLineCounts.get(docKey);
      const currentLineCount = e.document.lineCount;
      docLineCounts.set(docKey, currentLineCount);
      const lineCountDecreased = prevLineCount !== undefined && currentLineCount < prevLineCount;

      const deletedLineBreak = e.contentChanges.some(
        (change) => change.text === "" && change.range.start.line !== change.range.end.line
      );
      if (!deletedLineBreak && !lineCountDecreased) return;

      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document !== e.document) return;

      const line = Math.min(
        Math.max(0, e.contentChanges[0]?.range.start.line ?? 0),
        e.document.lineCount - 1
      );
      const candidates = [line, line - 1, line + 1];
      for (const ln of candidates) {
        if (ln < 0 || ln >= e.document.lineCount) continue;
        const block = findTreeBlock(e.document, ln);
        if (!block) continue;
        await normalizeTreeBlock(e.document, block);
        break;
      }
    }),
  );

  updateContext();
  updateDecorations(vscode.window.activeTextEditor);

  context.subscriptions.push(
    vscode.languages.registerFoldingRangeProvider(
      [
        { language: "tree", scheme: "file" },
        { language: "tree", scheme: "untitled" },
      ],
      {
        provideFoldingRanges: (document) => buildTreeFoldingRanges(document),
      }
    ),
    prefixDecoration,
    folderDecoration,
    fileDecoration,
    vscode.languages.registerCompletionItemProvider(
      [{ scheme: "file" }, { scheme: "untitled" }],
      {
        provideCompletionItems: (document, position) =>
          getTreeSnippetCompletion(document, position),
      },
      "|"
    ),
    vscode.commands.registerCommand("dottree.indent", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      await indentOrOutdent(editor, +1);
      updateContext(editor);
    }),
    vscode.commands.registerCommand("dottree.outdent", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      await indentOrOutdent(editor, -1);
      updateContext(editor);
    }),
    vscode.commands.registerCommand("dottree.newline", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      await insertSiblingLine(editor);
      updateContext(editor);
    })
  );
}

export function deactivate() {}
