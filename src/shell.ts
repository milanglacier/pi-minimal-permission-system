import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { Language, Parser, type Node } from "web-tree-sitter";

/** One command whose source text is matched against bash rules on its own. */
export interface ShellCommandUnit {
  /** Trimmed source text, sliced from the original input without rewriting. */
  text: string;
  /** Offset of the unit in the original input, in JavaScript string indices. */
  start: number;
}

export type ShellAnalysis =
  | { kind: "commands"; units: ShellCommandUnit[] }
  | { kind: "fallback"; reason: string };

// Bounds keep analysis cheap for pathological input; exceeding one falls back to whole-input matching.
const MAX_SOURCE_LENGTH = 100_000;
const MAX_SYNTAX_NODES = 200_000;
const MAX_COMMAND_UNITS = 2_000;
const MAX_NESTING_DEPTH = 256;
const PARSE_TIME_BUDGET_MS = 500;

// Statements matched as one unit, together with their assignment prefixes and redirections.
const COMMAND_TYPES = new Set([
  "command",
  "declaration_command",
  "unset_command",
  "test_command",
  "variable_assignment",
  "variable_assignments",
]);

// Compound statements that are never matched themselves; only the commands inside them are.
const CONTAINER_TYPES = new Set([
  "program",
  "list",
  "pipeline",
  "subshell",
  "compound_statement",
  "negated_command",
  "do_group",
  "if_statement",
  "elif_clause",
  "else_clause",
  "while_statement",
  "for_statement",
  "c_style_for_statement",
  "case_statement",
  "case_item",
  "function_definition",
]);

const SUBSTITUTION_TYPES = new Set(["command_substitution", "process_substitution"]);

// Leaf text where bash still runs `...` and $(...). tree-sitter-bash leaves some of these
// unparsed, such as backticks in heredoc bodies or `${x:-`cmd`}`, so their presence means
// the syntax tree is missing a command.
const EXPANDABLE_TEXT_TYPES = new Set(["word", "string_content", "heredoc_content", "regex", "extglob_pattern"]);

class UnsupportedSyntaxError extends Error {}

class LimitExceededError extends Error {}

interface SourceRange {
  start: number;
  end: number;
}

const resolveModule = createRequire(import.meta.url).resolve;
let parserPromise: Promise<Parser> | undefined;

async function createParser(): Promise<Parser> {
  // Read both WASM files from disk so loading does not depend on how the host resolves `import.meta.url`.
  const [runtime, grammar] = await Promise.all([
    readFile(resolveModule("web-tree-sitter/web-tree-sitter.wasm")),
    readFile(resolveModule("tree-sitter-bash/tree-sitter-bash.wasm")),
  ]);
  await Parser.init({ wasmBinary: runtime });
  const parser = new Parser();
  parser.setLanguage(await Language.load(grammar));
  return parser;
}

function getParser(): Promise<Parser> {
  parserPromise ??= createParser();
  return parserPromise;
}

/**
 * Splits a bash input into the commands present in its syntax, without executing or expanding anything.
 *
 * String arguments are never reparsed as scripts. Any parse error, limit, or unfamiliar syntax
 * yields a fallback so callers can match the whole input instead of a partial command list.
 */
export async function analyzeShellCommand(source: string): Promise<ShellAnalysis> {
  if (source.length > MAX_SOURCE_LENGTH) {
    return { kind: "fallback", reason: "the input exceeds shell analysis limits" };
  }

  let parser: Parser;
  try {
    parser = await getParser();
  } catch {
    return { kind: "fallback", reason: "the shell parser could not be loaded" };
  }

  const deadline = performance.now() + PARSE_TIME_BUDGET_MS;
  const tree = parser.parse(source, null, { progressCallback: () => performance.now() > deadline });
  if (!tree) {
    parser.reset();
    return { kind: "fallback", reason: "the input exceeds shell analysis limits" };
  }

  try {
    const root = tree.rootNode;
    if (root.hasError) {
      return { kind: "fallback", reason: "the input could not be parsed" };
    }
    if (root.descendantCount > MAX_SYNTAX_NODES) {
      return { kind: "fallback", reason: "the input exceeds shell analysis limits" };
    }

    const units = new CommandCollector(source).collect(root);
    if (units.length === 0) {
      return { kind: "fallback", reason: "the input contains no commands" };
    }

    return { kind: "commands", units };
  } catch (error) {
    if (error instanceof LimitExceededError) {
      return { kind: "fallback", reason: "the input exceeds shell analysis limits" };
    }
    if (error instanceof UnsupportedSyntaxError) {
      return { kind: "fallback", reason: `the input uses unsupported shell syntax (${error.message})` };
    }
    return { kind: "fallback", reason: "the input could not be analyzed" };
  } finally {
    tree.delete();
  }
}

class CommandCollector {
  private readonly units: ShellCommandUnit[] = [];
  private depth = 0;

  constructor(private readonly source: string) {}

  collect(root: Node): ShellCommandUnit[] {
    this.visitStatement(root);
    return this.units.sort((left, right) => left.start - right.start);
  }

  private enter(): void {
    this.depth += 1;
    if (this.depth > MAX_NESTING_DEPTH) {
      throw new LimitExceededError();
    }
  }

  private leave(): void {
    this.depth -= 1;
  }

  private visitStatement(node: Node): void {
    this.enter();
    try {
      if (COMMAND_TYPES.has(node.type)) {
        this.emitUnit(node, node.endIndex, [node], []);
      } else if (node.type === "redirected_statement") {
        this.visitRedirectedStatement(node);
      } else if (CONTAINER_TYPES.has(node.type)) {
        this.visitContainer(node);
      } else {
        throw new UnsupportedSyntaxError(node.type);
      }
    } finally {
      this.leave();
    }
  }

  private visitRedirectedStatement(node: Node): void {
    const body = node.childForFieldName("body");
    const redirects: Node[] = [];
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (child?.isNamed && node.fieldNameForChild(index) !== "body") {
        redirects.push(child);
      }
    }

    // A simple command keeps its trailing redirections in the same unit.
    if (!body || COMMAND_TYPES.has(body.type)) {
      this.emitUnit(node, node.endIndex, body ? [body] : [], redirects);
      return;
    }

    // Redirections on a compound statement become their own unit, next to the commands inside it.
    this.visitStatement(body);
    const first = redirects[0];
    const last = redirects.at(-1);
    if (first && last) {
      this.emitUnit(first, last.endIndex, [], redirects);
    }
  }

  private visitContainer(node: Node): void {
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (!child?.isNamed || child.type === "comment") {
        continue;
      }

      // The arithmetic header of `for ((...))` holds expressions, not statements.
      const isHeader = node.type === "c_style_for_statement" && node.fieldNameForChild(index) !== "body";
      if (!isHeader && isStatement(child)) {
        this.visitStatement(child);
      } else {
        this.scan(child, []);
      }
    }
  }

  /**
   * Adds one matching unit spanning from `startNode` to `end`.
   *
   * `commandNodes` are statements whose children belong to the unit; `extraNodes` are
   * additional parts, such as redirections. Both are scanned for nested commands.
   */
  private emitUnit(startNode: Node, end: number, commandNodes: readonly Node[], extraNodes: readonly Node[]): void {
    const excluded: SourceRange[] = [];
    for (const command of commandNodes) {
      for (const child of command.namedChildren) {
        this.scan(child, excluded);
      }
    }
    for (const node of extraNodes) {
      this.scan(node, excluded);
    }

    const text = sliceExcluding(this.source, startNode.startIndex, end, excluded);
    if (!text) {
      return;
    }

    this.units.push({ text, start: startNode.startIndex });
    if (this.units.length > MAX_COMMAND_UNITS) {
      throw new LimitExceededError();
    }
  }

  /**
   * Walks a non-statement node looking for nested commands.
   *
   * Statements that tree-sitter places inside a unit but that run separately are recorded in
   * `excluded`, so they are removed from the enclosing unit's text.
   */
  private scan(node: Node, excluded: SourceRange[]): void {
    this.enter();
    try {
      if (SUBSTITUTION_TYPES.has(node.type)) {
        this.visitContainer(node);
      } else if (node.type === "subshell" || node.type === "compound_statement" || node.type === "redirected_statement") {
        this.visitStatement(node);
      } else if (node.type === "heredoc_redirect") {
        this.scanHeredoc(node, excluded);
      } else if (isStatement(node) && node.type !== "variable_assignment") {
        throw new UnsupportedSyntaxError(`${node.type} inside a command`);
      } else if (node.childCount === 0 && EXPANDABLE_TEXT_TYPES.has(node.type)) {
        assertNoUnparsedSubstitution(node.text);
      } else {
        for (const child of node.namedChildren) {
          this.scan(child, excluded);
        }
      }
    } finally {
      this.leave();
    }
  }

  private scanHeredoc(node: Node, excluded: SourceRange[]): void {
    // tree-sitter nests statements that follow the heredoc marker on the same line inside the
    // redirect, as in `cat <<EOF | grep x` or `cat <<EOF && rm x`. They are separate commands.
    let operatorStart: number | undefined;
    let expandable = true;
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (!child) {
        continue;
      }

      const field = node.fieldNameForChild(index);
      if (child.type === "heredoc_start") {
        // Quoting any part of the delimiter makes the body literal.
        expandable = !/['"\\]/.test(child.text);
      } else if (child.type === "heredoc_body") {
        if (expandable) {
          this.scanHeredocBody(child, excluded);
        }
      } else if (field === "operator") {
        operatorStart = child.startIndex;
      } else if (field === "right" || (child.isNamed && child.type === "pipeline")) {
        excluded.push({ start: operatorStart ?? child.startIndex, end: child.endIndex });
        this.visitStatement(child);
      } else if (child.isNamed) {
        this.scan(child, excluded);
      }
    }
  }

  private scanHeredocBody(body: Node, excluded: SourceRange[]): void {
    const expansions = body.namedChildren.filter((child) => child.type !== "heredoc_content");
    const literalText = sliceExcluding(
      this.source,
      body.startIndex,
      body.endIndex,
      expansions.map((child) => ({ start: child.startIndex, end: child.endIndex })),
    );
    assertNoUnparsedSubstitution(literalText);

    for (const child of expansions) {
      this.scan(child, excluded);
    }
  }
}

function assertNoUnparsedSubstitution(text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
    } else if (char === "`" || (char === "$" && text[index + 1] === "(")) {
      throw new UnsupportedSyntaxError("a command substitution the parser did not recognize");
    }
  }
}

function isStatement(node: Node): boolean {
  return COMMAND_TYPES.has(node.type) || CONTAINER_TYPES.has(node.type) || node.type === "redirected_statement";
}

function sliceExcluding(source: string, start: number, end: number, excluded: readonly SourceRange[]): string {
  const ranges = excluded
    .filter((range) => range.start >= start && range.end <= end)
    .sort((left, right) => left.start - right.start);

  let text = "";
  let cursor = start;
  for (const range of ranges) {
    if (range.start > cursor) {
      text += source.slice(cursor, range.start).trimEnd();
    }
    cursor = Math.max(cursor, range.end);
  }
  text += source.slice(cursor, end);
  return text.trim();
}
