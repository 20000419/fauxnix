# Command specs

Generated from `CommandSpec`. Unlisted commands still use unchecked `parseWords` (unknown flags ignored). Spec'd commands fail loud on unknown or unsupported options.

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

## Unspec'd commands

`.`, `:`, `[`, `[[`, `alias`, `awk`, `base64`, `cd`, `clear`, `command`, `curl`, `date`, `dig`, `dirs`, `egrep`, `env`, `eval`, `exit`, `export`, `false`, `find`, `free`, `groups`, `gunzip`, `gzip`, `history`, `host`, `hostname`, `id`, `ifconfig`, `ip`, `kill`, `less`, `man`, `md5sum`, `more`, `netstat`, `nl`, `nproc`, `nslookup`, `pgrep`, `ping`, `pkill`, `popd`, `printenv`, `ps`, `pushd`, `pwd`, `read`, `sed`, `seq`, `set`, `sha1sum`, `sha256sum`, `shift`, `sleep`, `source`, `ss`, `sudo`, `tac`, `tar`, `test`, `timeout`, `true`, `type`, `uname`, `unset`, `unzip`, `uptime`, `wget`, `which`, `whoami`, `xargs`, `yes`, `zcat`, `zip`
