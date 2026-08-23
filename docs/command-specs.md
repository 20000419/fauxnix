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

## Unspec'd commands

`.`, `:`, `[`, `[[`, `alias`, `awk`, `base64`, `basename`, `cat`, `cd`, `chmod`, `chown`, `clear`, `command`, `curl`, `cut`, `date`, `df`, `diff`, `dig`, `dirname`, `dirs`, `echo`, `egrep`, `env`, `eval`, `exit`, `export`, `false`, `file`, `find`, `free`, `groups`, `gunzip`, `gzip`, `history`, `host`, `hostname`, `id`, `ifconfig`, `ip`, `kill`, `less`, `ll`, `ln`, `ls`, `man`, `md5sum`, `mkdir`, `mktemp`, `more`, `netstat`, `nl`, `nproc`, `nslookup`, `pgrep`, `ping`, `pkill`, `popd`, `printenv`, `printf`, `ps`, `pushd`, `pwd`, `read`, `readlink`, `realpath`, `rmdir`, `sed`, `seq`, `set`, `sha1sum`, `sha256sum`, `sleep`, `sort`, `source`, `ss`, `stat`, `sudo`, `tac`, `tail`, `tar`, `test`, `timeout`, `tr`, `true`, `type`, `uname`, `uniq`, `unset`, `unzip`, `uptime`, `wc`, `wget`, `which`, `whoami`, `xargs`, `yes`, `zcat`, `zip`
