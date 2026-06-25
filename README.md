# @foister150/pi-tagging

A [pi](https://pi.dev) extension that lets you organize your sessions with
**path-style, hierarchical tags** and browse them as a file-tree-like structure.

- `/tag` — view/add/remove tags on the **current** session
- `/tag <tag…>` — quick-add one or more tags (e.g. `/tag coordinate/commands`)
- `/tag pick` — choose any session, then edit its tags
- `/tag-view` — browse every session as a tag tree; switch, rename, delete, or
  retag from there

Tags use a `/` separator to form sub-tags, so `pcoordinate/commands` is a child of
`coordinate`. Untagged sessions are grouped under an `etc` bucket. Tags are stored
centrally in `~/.pi/agent/session-tags.json` and refreshed in the background on
every session start.

## Install

```bash
pi install npm:@foister150/pi-tagging
```

Or pin a version:

```bash
pi install npm:@foister150/pi-tagging@0.1.0
```

Install from git instead of npm:

```bash
pi install git:github.com/Foister150/pi-tagging
```

Try it for a single run without installing:

```bash
pi -e npm:@foister150/pi-tagging
```

## Usage

### Tagging

```text
/tag                      # interactive add/remove menu for the current session
/tag coordinate/commands  # quick-add (space-separated, path-style, multiple ok)
/tag coordinate infra/ci   # add several at once
/tag pick                 # choose another session, then edit its tags
```

Sub-tags are just tags with a `/` in them — `coordinate/commands/base64` is three
levels deep.

### Browsing

```text
/tag-view
```

Top level shows your tags (`coordinate`, `infra`, …) plus an `etc` bucket for
untagged sessions. Drill into `📁` folders; selecting a session (`🗎`) opens an
action menu:

- **Switch / resume** into the session
- **Edit tags**
- **Rename**
- **Delete** (moved to trash — uses the `trash` CLI when available, otherwise
  `~/.pi/agent/sessions-trash/<timestamp>/`, so deletes stay recoverable)

## How tags are stored

A single JSON index at `~/.pi/agent/session-tags.json`, keyed by session file
path. `/tag-view` reconciles the index against the sessions that actually exist
on disk each run (adding new sessions as untagged, pruning ghosts of deleted
files), so it is self-healing.

## License

MIT © Landon Foister
