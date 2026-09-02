# Command specs

Generated from `CommandSpec`. Unlisted commands still use unchecked `parseWords` (unknown flags ignored). Spec'd commands fail loud on unknown or unsupported options.

## Agent-daily 60 (C-5)

Curated command names: `basename`, `cat`, `cd`, `chmod`, `chown`, `clear`, `command`, `cp`, `cut`, `date`, `df`, `diff`, `dirname`, `du`, `echo`, `env`, `export`, `file`, `free`, `grep`, `groups`, `gunzip`, `gzip`, `head`, `hostname`, `id`, `ll`, `ln`, `ls`, `mkdir`, `mktemp`, `mv`, `nproc`, `printenv`, `printf`, `ps`, `pwd`, `readlink`, `realpath`, `rm`, `rmdir`, `sleep`, `sort`, `stat`, `tail`, `tee`, `timeout`, `touch`, `tr`, `type`, `uname`, `uniq`, `unset`, `unzip`, `uptime`, `wc`, `which`, `whoami`, `zcat`, `zip`

Coverage: **60 / 60 spec'd**.

## Intentional CommandSpec exclusions

These commands stay outside the generic option walker by design. This is a structural rationale, not a claim that every command-specific option path is already strict.

| Command | Rationale |
| --- | --- |
| `find` | option-looking predicates are parsed by the find expression compiler; generic short-option bundling would misread -name |
| `sed`, `awk` | program text and option grammar require command-specific parsing; any remaining unchecked options must be fixed there rather than treated as generic flags |
| `egrep` | semantic alias injects grep -E through its own handler; it must not be wrapped as an independent generic option parser |
| `tar` | argv is passed to Windows bsdtar; rejecting unlisted GNU/bsdtar options before native dispatch would reduce compatibility |

## `cp`

Effects: `read`, `write`

| Option | Value | Support |
| --- | --- | --- |
| `-r` | flag | implemented |
| `-R`, `--recursive` | flag | implemented |
| `-v`, `--verbose` | flag | implemented |
| `-n`, `--no-clobber` | flag | implemented |
| `-f`, `--force` | flag | implemented |
| `-i`, `--interactive` | flag | unsupported (interactive prompt) |

## `mv`

Effects: `read`, `write`, `delete`

| Option | Value | Support |
| --- | --- | --- |
| `-v`, `--verbose` | flag | implemented |
| `-n`, `--no-clobber` | flag | implemented |
| `-f`, `--force` | flag | implemented |
| `-i`, `--interactive` | flag | unsupported (interactive prompt) |

## `rm`

Effects: `delete`

| Option | Value | Support |
| --- | --- | --- |
| `-r` | flag | implemented |
| `-R`, `--recursive` | flag | implemented |
| `-f`, `--force` | flag | implemented |
| `-v`, `--verbose` | flag | implemented |
| `-i`, `--interactive` | flag | unsupported (interactive prompt) |

## `touch`

Effects: `write`

| Option | Value | Support |
| --- | --- | --- |
| `-c`, `--no-create` | flag | implemented |

## `du`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-s`, `--summarize` | flag | implemented |
| `-h`, `--human-readable` | flag | implemented |
| `-d`, `--max-depth` | required | implemented |

## `ls` / `ll`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-l`, `--long` | flag | implemented |
| `--format` | required | implemented |
| `-a`, `--all` | flag | implemented |
| `-A`, `--almost-all` | flag | implemented |
| `-d`, `--directory` | flag | implemented |
| `-h`, `--human-readable` | flag | implemented |
| `-F`, `--classify` | flag | implemented |
| `-p` | flag | implemented |
| `-t` | flag | implemented |
| `-S` | flag | implemented |
| `-r` | flag | implemented |
| `-R`, `--recursive` | flag | unsupported (recursive listing) |
| `--color` | required | implemented |

## `mkdir`

Effects: `write`

| Option | Value | Support |
| --- | --- | --- |
| `-p`, `--parents` | flag | implemented |
| `-v`, `--verbose` | flag | implemented |

## `rmdir`

Effects: `delete`

No options declared.

## `mktemp`

Effects: `write`

| Option | Value | Support |
| --- | --- | --- |
| `-d`, `--directory` | flag | implemented |

## `ln`

Effects: `read`, `write`

| Option | Value | Support |
| --- | --- | --- |
| `-s`, `--symbolic` | flag | implemented |

## `readlink`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-f`, `--canonicalize` | flag | implemented |

## `realpath`

Effects: `read`

No options declared.

## `basename`

Effects: `read`

No options declared.

## `dirname`

Effects: `read`

No options declared.

## `stat`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-c` | required | implemented |
| `--format` | required | implemented |
| `--printf` | required | implemented |

## `file`

Effects: `read`

No options declared.

## `df`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-h`, `--human-readable` | flag | implemented |
| `-H` | flag | implemented |

## `chmod`

Effects: `write`

| Option | Value | Support |
| --- | --- | --- |
| `-R`, `--recursive` | flag | unsupported (recursive chmod) |

## `chown`

Effects: `write`

No options declared.

## `diff`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-q`, `--brief` | flag | implemented |
| `-u`, `--unified` | flag | implemented |
| `-U` | flag | implemented |

## `tee`

Effects: `read`, `write`

| Option | Value | Support |
| --- | --- | --- |
| `-a`, `--append` | flag | implemented |

## `head`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-n`, `--lines` | required | implemented |
| `-c`, `--bytes` | required | implemented |
| `-q`, `--quiet` | flag | implemented |
| `--silent` | flag | implemented |
| `-v`, `--verbose` | flag | implemented |

## `echo`

Effects: none

| Option | Value | Support |
| --- | --- | --- |
| `-n` | flag | implemented |
| `-e` | flag | implemented |
| `-E` | flag | implemented |

## `printf`

Effects: none

No options declared.

## `cat`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-n` | flag | implemented |
| `-b` | flag | implemented |
| `-s` | flag | implemented |
| `-E` | flag | implemented |
| `-T` | flag | implemented |
| `-A` | flag | implemented |

## `tail`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-n`, `--lines` | required | implemented |
| `-c`, `--bytes` | required | implemented |
| `-q`, `--quiet` | flag | implemented |
| `--silent` | flag | implemented |
| `-v`, `--verbose` | flag | implemented |
| `-f` | flag | unsupported (no persistent tty) |
| `-F` | flag | unsupported (no persistent tty) |

## `wc`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-l` | flag | implemented |
| `-w` | flag | implemented |
| `-c` | flag | implemented |
| `-m` | flag | implemented |

## `grep`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-i` | flag | implemented |
| `-v` | flag | implemented |
| `-n` | flag | implemented |
| `-c` | flag | implemented |
| `-l` | flag | implemented |
| `-r` | flag | implemented |
| `-R` | flag | implemented |
| `-E` | flag | implemented |
| `-F` | flag | implemented |
| `-w` | flag | implemented |
| `-q` | flag | implemented |
| `-o` | flag | implemented |
| `-h` | flag | implemented |
| `-H` | flag | implemented |
| `-A` | required | implemented |
| `-B` | required | implemented |
| `-C` | required | implemented |
| `-m`, `--max-count` | required | implemented |
| `-e`, `--regexp` | required | implemented |
| `--include` | required | implemented |
| `--exclude` | required | implemented |
| `--exclude-dir` | required | implemented |

## `sort`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-r`, `--reverse` | flag | implemented |
| `-n`, `--numeric-sort` | flag | implemented |
| `-u`, `--unique` | flag | implemented |
| `-f`, `--ignore-case` | flag | implemented |
| `-b`, `--ignore-leading-blanks` | flag | implemented |
| `-t` | required | implemented |
| `-k` | required | implemented |
| `-z`, `--zero-terminated` | flag | unsupported (NUL-terminated records) |

## `uniq`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-c` | flag | implemented |
| `-d` | flag | implemented |
| `-u` | flag | implemented |
| `-i` | flag | implemented |

## `cut`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-d` | required | implemented |
| `-f` | required | implemented |
| `-c` | required | implemented |
| `-b` | required | implemented |
| `-s` | flag | implemented |
| `--complement` | flag | implemented |

## `tr`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-d` | flag | implemented |
| `-s` | flag | implemented |
| `-c`, `--complement` | flag | unsupported (complement) |
| `-C` | flag | unsupported (complement) |

## `gzip`

Effects: `read`, `write`, `delete`

| Option | Value | Support |
| --- | --- | --- |
| `-d`, `--decompress` | flag | implemented |
| `--uncompress` | flag | implemented |
| `-k`, `--keep` | flag | implemented |
| `-c`, `--stdout` | flag | implemented |
| `--to-stdout` | flag | implemented |
| `-t`, `--test` | flag | implemented |
| `-1`, `--fast` | flag | implemented |
| `-2` | flag | implemented |
| `-3` | flag | implemented |
| `-4` | flag | implemented |
| `-5` | flag | implemented |
| `-6` | flag | implemented |
| `-7` | flag | implemented |
| `-8` | flag | implemented |
| `-9`, `--best` | flag | implemented |
| `-f`, `--force` | flag | unsupported (force from terminal) |
| `-q`, `--quiet` | flag | unsupported (quiet) |
| `-v`, `--verbose` | flag | unsupported (verbose) |
| `-n`, `--no-name` | flag | unsupported (no-name) |
| `-r`, `--recursive` | flag | unsupported (recursive) |
| `-S`, `--suffix` | required | unsupported (suffix) |

## `gunzip`

Effects: `read`, `write`, `delete`

| Option | Value | Support |
| --- | --- | --- |
| `-d`, `--decompress` | flag | implemented |
| `--uncompress` | flag | implemented |
| `-k`, `--keep` | flag | implemented |
| `-c`, `--stdout` | flag | implemented |
| `--to-stdout` | flag | implemented |
| `-t`, `--test` | flag | implemented |
| `-1`, `--fast` | flag | implemented |
| `-2` | flag | implemented |
| `-3` | flag | implemented |
| `-4` | flag | implemented |
| `-5` | flag | implemented |
| `-6` | flag | implemented |
| `-7` | flag | implemented |
| `-8` | flag | implemented |
| `-9`, `--best` | flag | implemented |
| `-f`, `--force` | flag | unsupported (force from terminal) |
| `-q`, `--quiet` | flag | unsupported (quiet) |
| `-v`, `--verbose` | flag | unsupported (verbose) |
| `-n`, `--no-name` | flag | unsupported (no-name) |
| `-r`, `--recursive` | flag | unsupported (recursive) |
| `-S`, `--suffix` | required | unsupported (suffix) |

## `zcat`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-d`, `--decompress` | flag | implemented |
| `--uncompress` | flag | implemented |
| `-k`, `--keep` | flag | implemented |
| `-c`, `--stdout` | flag | implemented |
| `--to-stdout` | flag | implemented |
| `-t`, `--test` | flag | implemented |
| `-1`, `--fast` | flag | implemented |
| `-2` | flag | implemented |
| `-3` | flag | implemented |
| `-4` | flag | implemented |
| `-5` | flag | implemented |
| `-6` | flag | implemented |
| `-7` | flag | implemented |
| `-8` | flag | implemented |
| `-9`, `--best` | flag | implemented |
| `-f`, `--force` | flag | unsupported (force from terminal) |
| `-q`, `--quiet` | flag | unsupported (quiet) |
| `-v`, `--verbose` | flag | unsupported (verbose) |
| `-n`, `--no-name` | flag | unsupported (no-name) |
| `-r`, `--recursive` | flag | unsupported (recursive) |
| `-S`, `--suffix` | required | unsupported (suffix) |

## `zip`

Effects: `read`, `write`

| Option | Value | Support |
| --- | --- | --- |
| `-r` | flag | implemented |
| `-q` | flag | implemented |
| `-x`, `--exclude` | required | unsupported (exclude patterns) |

## `unzip`

Effects: `read`, `write`

| Option | Value | Support |
| --- | --- | --- |
| `-l` | flag | implemented |
| `-o` | flag | implemented |
| `-q` | flag | implemented |
| `-d`, `--directory` | required | implemented |

## `cd`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-L` | flag | implemented |
| `-P` | flag | unsupported (physical symlink/junction resolution) |
| `-e` | flag | unsupported (physical-resolution failure mode) |
| `-@` | flag | unsupported (extended-attribute directory view) |

## `pwd`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-L` | flag | implemented |
| `-P` | flag | unsupported (physical symlink/junction resolution) |
| `-W` | flag | unsupported (MSYS Windows-path output) |

## `export`

Effects: `read`, `write`

| Option | Value | Support |
| --- | --- | --- |
| `-f` | flag | unsupported (shell functions are not supported) |
| `-n` | flag | unsupported (all fauxnix variables live in the session environment) |
| `-p` | flag | unsupported (declare-style shell output) |

## `unset`

Effects: `write`

| Option | Value | Support |
| --- | --- | --- |
| `-v` | flag | implemented |
| `-f` | flag | unsupported (shell functions are not supported) |
| `-n` | flag | unsupported (nameref variables are not supported) |

## `env`

Effects: `process`

| Option | Value | Support |
| --- | --- | --- |
| `-u`, `--unset` | required | implemented (literal variable names only) |
| `-i`, `--ignore-environment` | flag | unsupported (would silently keep inherited secrets; use env -u NAME or unset first) |
| `-0`, `--null` | flag | unsupported (NUL-terminated output) |
| `-C`, `--chdir` | required | unsupported (temporary working directory) |
| `-S`, `--split-string` | required | unsupported (shell-like string splitting) |

## `printenv`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-0`, `--null` | flag | unsupported (NUL-terminated output) |

## `ps`

Effects: `process`

| Option | Value | Support |
| --- | --- | --- |
| `-e`, `--everyone` | flag | implemented |
| `-A`, `--all` | flag | implemented |
| `-f` | flag | implemented |
| `-a` | flag | unsupported (terminal-based process selection) |
| `-x` | flag | unsupported (terminal-based process selection) |
| `-u` | flag | unsupported (BSD user-oriented format) |
| `--user` | required | unsupported (user filtering) |
| `-p`, `--pid` | required | unsupported (PID filtering) |
| `-o`, `--format` | required | unsupported (custom output columns) |
| `--sort` | required | unsupported (custom process ordering) |

## `sleep`

Effects: `process`

No options declared.

## `which`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-a`, `--all` | flag | unsupported (all matching PATH entries) |
| `-s` | flag | unsupported (silent status-only mode) |

## `type`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-a` | flag | unsupported (all matching definitions) |
| `-f` | flag | unsupported (shell functions are not supported) |
| `-P` | flag | unsupported (forced PATH lookup) |
| `-p` | flag | unsupported (PATH-only lookup) |
| `-t` | flag | unsupported (type-name-only output) |

## `command`

Effects: `process`

| Option | Value | Support |
| --- | --- | --- |
| `-v` | flag | implemented |
| `-V` | flag | implemented |
| `-p` | flag | unsupported (guaranteed default utility PATH) |

## `whoami`

Effects: `read`

No options declared.

## `id`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-u` | flag | implemented |
| `-g` | flag | implemented |
| `-n` | flag | implemented |
| `-G` | flag | unsupported (supplementary group ID mapping) |
| `-r` | flag | unsupported (real versus effective IDs) |
| `-z` | flag | unsupported (NUL-terminated output) |
| `-Z` | flag | unsupported (SELinux security context) |

## `groups`

Effects: `read`

No options declared.

## `date`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-u`, `--utc` | flag | implemented |
| `-d`, `--date` | required | implemented (@SECONDS input only) |
| `-I`, `--iso-8601` | flag | unsupported (ISO precision selection) |
| `-R`, `--rfc-email` | flag | unsupported (RFC email formatting) |
| `--rfc-3339` | required | unsupported (RFC 3339 precision selection) |
| `-r`, `--reference` | required | unsupported (file timestamp lookup) |
| `-s`, `--set` | required | unsupported (changing the system clock) |

## `uname`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-a`, `--all` | flag | implemented |
| `-s`, `--kernel-name` | flag | implemented |
| `-n`, `--nodename` | flag | implemented |
| `-r`, `--kernel-release` | flag | implemented |
| `-v`, `--kernel-version` | flag | implemented |
| `-m`, `--machine` | flag | implemented |
| `-p`, `--processor` | flag | implemented |
| `-o`, `--operating-system` | flag | implemented |
| `-i`, `--hardware-platform` | flag | unsupported (hardware-platform distinction) |

## `hostname`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-s`, `--short` | flag | unsupported (short-name selection) |
| `-f`, `--fqdn` | flag | unsupported (FQDN lookup) |
| `-d`, `--domain` | flag | unsupported (DNS domain lookup) |
| `-i`, `--ip-address` | flag | unsupported (address lookup) |
| `-I`, `--all-ip-addresses` | flag | unsupported (all-address lookup) |
| `-F`, `--file` | required | unsupported (changing the hostname from a file) |

## `uptime`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-p`, `--pretty` | flag | unsupported (pretty duration output) |
| `-s`, `--since` | flag | unsupported (boot timestamp output) |

## `free`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `-h`, `--human` | flag | implemented |
| `-k`, `--kibi` | flag | implemented |
| `-m`, `--mebi` | flag | implemented |
| `-g`, `--gibi` | flag | implemented |
| `-b`, `--bytes` | flag | unsupported (byte-unit output) |
| `--si` | flag | unsupported (powers-of-1000 units) |
| `-t`, `--total` | flag | unsupported (total row) |
| `-w`, `--wide` | flag | unsupported (wide buffer/cache columns) |
| `-s`, `--seconds` | required | unsupported (repeating output) |
| `-c`, `--count` | required | unsupported (repeating output) |

## `nproc`

Effects: `read`

| Option | Value | Support |
| --- | --- | --- |
| `--all` | flag | unsupported (installed versus available processor distinction) |
| `--ignore` | required | unsupported (processor-count subtraction) |

## `clear`

Effects: none

| Option | Value | Support |
| --- | --- | --- |
| `-x` | flag | unsupported (scrollback-preserving terminal control) |
| `-T` | required | unsupported (alternate terminal type) |

## `timeout`

Effects: `process`

| Option | Value | Support |
| --- | --- | --- |
| `-s`, `--signal` | required | unsupported (signal selection) |
| `-k`, `--kill-after` | required | unsupported (two-phase termination) |
| `--preserve-status` | flag | unsupported (child-status preservation after timeout) |
| `--foreground` | flag | unsupported (interactive foreground process groups) |
| `-v`, `--verbose` | flag | unsupported (signal diagnostics) |

## Unspec'd commands

`.`, `:`, `[`, `[[`, `alias`, `awk`, `base64`, `curl`, `dig`, `dirs`, `egrep`, `eval`, `exit`, `false`, `find`, `history`, `host`, `ifconfig`, `ip`, `kill`, `less`, `man`, `md5sum`, `more`, `netstat`, `nl`, `nslookup`, `pgrep`, `ping`, `pkill`, `popd`, `pushd`, `read`, `sed`, `seq`, `set`, `sha1sum`, `sha256sum`, `shift`, `source`, `ss`, `sudo`, `tac`, `tar`, `test`, `true`, `wget`, `xargs`, `yes`
