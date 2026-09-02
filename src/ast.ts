/**
 * Fauxnix AST — a pragmatic subset of POSIX/bash command syntax.
 *
 * Supported:
 *   - pipelines:            cmd1 | cmd2 | cmd3
 *   - lists:                cmd1 ; cmd2 && cmd3 || cmd4   (newlines act as ';')
 *   - redirections:         > >> 2> 2>> &> 2>&1 1>&2 <
 *   - quoting:              'literal'  "interp $VAR $(cmd)"
 *   - variables:            $VAR ${VAR} ${VAR[n]} ${name//pat/str} ${name:off:len}
 *                           plus special cases ($HOME $USER $PATH ...)
 *   - command substitution: $(...) and `...` (recursively translated)
 *   - arithmetic expansion: $((...)) (existing fx-arith engine)
 *   - env assignment prefix: VAR=value cmd
 *   - array assignment:     A=(x y z)  (sidecar FAUXNIX_ARRS)
 *
 * Explicitly unsupported (parser throws a helpful FauxnixError):
 *   heredocs, subshells (...), background &, while/until/case,
 *   globs inside quotes, process substitution <(...).
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

export type ShellCommand = SimpleCommand | IfCommand | ForCommand;

export interface Pipeline {
  kind: 'Pipeline';
  commands: ShellCommand[];
}

export interface IfCommand {
  kind: 'If';
  test: CommandList;
  then: CommandList;
  else?: CommandList;
  redirects: Redirect[];
}

export interface ForCommand {
  kind: 'For';
  name: string;
  words: Word[];
  body: CommandList;
  redirects: Redirect[];
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
  /** Scalar value; for arrays, first element (or empty Word) so export paths stay valid. */
  value: Word;
  /** Set ⇒ bash array assignment `A=(x y z)`. */
  values?: Word[];
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
      /** `${#name}` / `${#name[@]}` — string/array length expansion. */
      length?: boolean;
      /** `${name/pat/str}` (first) / `${name//pat/str}` (global). Pattern is a bash glob. */
      replace?: { global: boolean; pat: string; repl: string };
      /** `${name:offset}` / `${name:offset:length}` — scalar substring. */
      slice?: { offset: string; length?: string };
    }
  | { kind: 'CmdSub'; cmd: string }
  | { kind: 'Arith'; parts: WordPart[] };

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
      if (p.replace) {
        const sep = p.replace.global ? '//' : '/';
        return `\${${p.name}${sep}${p.replace.pat}/${p.replace.repl}}`;
      }
      if (p.slice) {
        return p.slice.length !== undefined
          ? `\${${p.name}:${p.slice.offset}:${p.slice.length}}`
          : `\${${p.name}:${p.slice.offset}}`;
      }
      if (p.length) {
        return p.index !== undefined
          ? `\${#${p.name}[${p.index}]}`
          : `\${#${p.name}}`;
      }
      if (p.param) {
        return `\${${p.name}${p.param.op}${p.param.word}}`;
      }
      return p.index !== undefined ? `\${${p.name}[${p.index}]}` : `$${p.name}`;
    case 'CmdSub':
      return '$(' + p.cmd + ')';
    case 'Arith':
      return '$((' + p.parts.map(partToString).join('') + '))';
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
