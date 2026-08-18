/**
 * Fauxnix AST — a pragmatic subset of POSIX/bash command syntax.
 *
 * Supported:
 *   - pipelines:            cmd1 | cmd2 | cmd3
 *   - lists:                cmd1 ; cmd2 && cmd3 || cmd4   (newlines act as ';')
 *   - redirections:         > >> 2> 2>> &> 2>&1 1>&2 <
 *   - quoting:              'literal'  "interp $VAR $(cmd)"
 *   - variables:            $VAR ${VAR} ${VAR[n]} plus special cases ($HOME $USER $PATH ...)
 *   - command substitution: $(...) (recursively translated)
 *   - env assignment prefix: VAR=value cmd
 *
 * Explicitly unsupported (parser throws a helpful FauxnixError):
 *   heredocs, backticks, subshells (...), background &, control flow
 *   (if/for/while), globs inside quotes, process substitution <(...).
 */

export interface CommandList {
  kind: 'CommandList';
  segments: ListSegment[];
}

/** One pipeline plus the operator that connects it to the *previous* segment. */
export interface ListSegment {
  pipeline: Pipeline;
  /** ';' for the first segment, otherwise the operator seen before this one. */
  op: ';' | '&&' | '||';
}

export interface Pipeline {
  kind: 'Pipeline';
  commands: SimpleCommand[];
}

export interface SimpleCommand {
  kind: 'SimpleCommand';
  /** `VAR=value` prefixes before the command name. */
  assignments: Assignment[];
  /** Command word; null for an assignment-only segment (`X=1; cmd`). */
  name: Word | null;
  args: Word[];
  redirects: Redirect[];
}

export interface Assignment {
  name: string;
  value: Word;
}

export type RedirectOp =
  | '>' | '>>' | '2>' | '2>>' | '&>' | '&>>'
  | '2>&1' | '1>&2' | '<';

export interface Redirect {
  op: RedirectOp;
  /** Target path (words are already flattened; no vars in v1 targets except $VAR which is kept raw). */
  target: string;
}

/** A word is a sequence of parts that concatenate into one argument. */
export type Word = WordPart[];

export type WordPart =
  | { kind: 'Text'; text: string; escaped?: boolean }
  | { kind: 'SingleQuoted'; text: string }
  | { kind: 'DoubleQuoted'; parts: WordPart[] }
  | {
      kind: 'Var';
      name: string;
      index?: string;
      /** `${name:-word}` / `${name:+word}` / `${name:?word}` (and non-colon). */
      param?: { op: ':-' | ':=' | ':+' | ':?' | '-' | '+' | '?'; word: string };
    }
  | { kind: 'CmdSub'; cmd: string };

export function wordToString(w: Word): string {
  return w.map(partToString).join('');
}

/** True when every part is unquoted Text and the concatenation equals `tok`. */
export function isUnquotedLiteral(w: Word, tok: string): boolean {
  return (
    w.length > 0 &&
    w.every((p) => p.kind === 'Text' && !p.escaped) &&
    wordToString(w) === tok
  );
}

/** True when no part is single- or double-quoted. */
export function isFullyUnquoted(w: Word): boolean {
  return w.every((p) => p.kind !== 'SingleQuoted' && p.kind !== 'DoubleQuoted');
}

function partToString(p: WordPart): string {
  switch (p.kind) {
    case 'Text':
      return p.text;
    case 'SingleQuoted':
      return p.text;
    case 'DoubleQuoted':
      return p.parts.map(partToString).join('');
    case 'Var':
      return p.index !== undefined ? `\${${p.name}[${p.index}]}` : `$${p.name}`;
    case 'CmdSub':
      return '$(' + p.cmd + ')';
  }
}

/** Best-effort "raw literal" view: is this word free of interpolation? */
export function isLiteralWord(w: Word): boolean {
  return w.every((p) => p.kind === 'Text' || p.kind === 'SingleQuoted');
}

export class FauxnixParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FauxnixParseError';
  }
}
