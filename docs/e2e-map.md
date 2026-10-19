# E2E map — cc-stretch

A Claude Code plugin: in the terminal's fullscreen layout a reply's stretches open in place when
clicked, and text in such a paragraph is selected by the plugin itself.

## Environments

| Environment | Reach | Ready when | Which build | Accounts | May write | Started by |
|---|---|---|---|---|---|---|
| local | `claude --plugin-dir <package> --settings '{"enabledPlugins":{"cc-stretch@cc-stretch":false}}'`, run with `CLAUDE_CODE_NO_FLICKER=1` in a WezTerm pane of 100 × 30 | the prompt's `❯` drawn under a rule | `<package>` is `git archive <sha>` of the commit under test, without `tests/` | the Claude Code login already on the machine | the clipboard, through a drag or a double-click: save its text first and put it back; the user's settings file, through the style toolbar's save: the checks put it back | you, or a `film/e2e/` check |

There is no staging or production: the plugin runs only inside a reader's own Claude Code.

As of Claude Code 2.1.302, `/reload-plugins` refuses a copy of the plugin under a folder's
`.claude/skills/` while cc-stretch from the marketplace is installed, whichever folder it was
installed for: the name "cc-stretch" is already taken by cc-stretch@cc-stretch, which takes
precedence. So a session under test is started with `--plugin-dir`.

## Scripted

`npm test` runs `claude plugin validate .` and the specs in `tests/` under Claude Code's test
harness. The harness stands in for the host, so it does not draw a terminal, move a pointer or
reload the plugin: drawing, clicks and drags are proved in a live session.

## Driving a live session

`openPane` in `film/recorder.mjs` holds the pattern. Open the pane with `wezterm cli spawn` and
`split-pane`; type with `wezterm cli send-text --no-paste`; click by sending SGR mouse sequences; read every
screen with `wezterm cli get-text --escapes` and parse it with `film/screen.mjs`, which keeps
colours, underline, inverse and OSC 8 links. Wait for what the screen should show, never a fixed
delay: under load a redraw after a press took over a second.

As of WezTerm 20260905-195314-b99b1ca2, `get-text --escapes` can give a paragraph's first row the
style the paragraph above ends in, such as an open stretch's underlined `«`, though the pane does not
draw it (`firstCarriedRow` in `film/screen.mjs` says why). `openPane` reads such a row again. To see
one row's own style by hand, read it alone with `--start-line` and `--end-line`.

As of Claude Code 2.1.302 a session reads a click's position in cells, counted from 1, until its
`--debug-file` log says `Mouse reports in pixels`, and in pixels from then on, at a cell's middle
pixel. In these runs the switch came once a reply holding a stretch was drawn, so a click sent in
pixels before that, such as on the style toolbar in a new session, is lost. Read the log before each
click, as `openPane`'s `mouse` does when it is given the log.

`film/e2e/` holds checks built on that pattern: `node film/e2e/<check>.mjs <package> <outDir>` starts
the session, runs steps that pass or fail on what the screen shows, writes every screen and a report
into `<outDir>`, and exits 1 if a step failed; `node film/e2e/render.mjs <outDir>` turns them into
`check.mp4`.

## Features

### Open and close a stretch

- **Reach:** a reply whose paragraph holds a stretch; ask for "two stretches" in the prompt.
- **Drive:**
  1. Click a closed stretch (an underlined run that is not an OSC 8 link): its words grow in place,
     tinted, ending in `«`.
  2. Click the `«`: the stretch shrinks back to its short form.
- **Writes:** nothing.
- **Gotchas:** with `CLAUDE_CODE_NO_FLICKER=0` the session draws on the main screen, where every
  stretch is drawn open and nothing is pressable.

### Select text in a paragraph that holds a stretch

- **Reach:** a press away from a stretch, dragged, or two on one word, inside such a paragraph.
- **Drive:**
  1. Press, move with the button held, release inside the paragraph: the cells crossed are drawn
     inverse and their text is on the clipboard.
  2. Move the pointer into the paragraph and out of it: the highlight goes.
  3. Click a word twice, the presses less than 500 ms and at most a cell apart: the word is drawn
     inverse and on the clipboard. It is the word Claude Code 2.1.303 takes in a paragraph without
     a stretch, except that `#` stays in it and any full stops after it stay out.
- **Writes:** the clipboard; save its text first and put it back.
- **Gotchas:** the paragraph hears the pointer leave only after it has heard it inside, so a driver
  that only sends a motion outside never clears a highlight.

### The style toolbar

- **Reach:** `/cc-stretch:style`; typing `/cc-stretch` lists it. `film/e2e/style.mjs` and
  `film/e2e/tinted.mjs` check most of the steps below, and besides them dim on a highlight, the
  letters, a reopened toolbar and a drag across a link; `film/e2e/stream-save.mjs` saves while a
  reply streams and checks that no screen shows a long form's markup.
- **Drive:**
  1. Run the command: `marks  bold italic [underline] strikethrough dim close` and
     `highlight  [no highlight] colour tinted` appear above the prompt.
  2. Press a mark: every closed stretch restyles at once, and `reset save` appear before `close`.
  3. Press `colour`: nine deep swatches appear on the highlight row. Press one: every closed stretch
     sits on it, its text turned light.
  4. Press `tinted`: the swatches go, and each closed stretch sits on the colour its words take once
     open, by its place in the reply. Open one: its words and its `«` are in that colour.
  5. Press `reset`: back to the saved style.
  6. Press `save`: the marks row reads `saving` until Claude Code prints that the plugin reloaded;
     then the toolbar shows the saved style with nothing to save.
  7. Press a mark, then `close`: the toolbar goes, the reply returns to the saved style, and a
     toast says the try was not saved.
  8. Press Claude Code's own `[-]` at the toolbar's right (as of 2.1.302): the panel collapses to "plugin panel
     hidden"; clicking that line brings it back.
  9. On the main screen (`CLAUDE_CODE_NO_FLICKER=0`) the command says the toolbar is drawn in
     fullscreen.
- **Writes:** save writes `marks` and `highlight` under `pluginConfigs` in the user's settings
  file (as of Claude Code 2.1.302); a plugin loaded with `--plugin-dir` is keyed `cc-stretch@inline`.
  The checks keep the file at the start and put it back when that entry is its only change.
- **Gotchas:**
  - As of Claude Code 2.1.302, a session started with `--setting-sources project,local` cannot read
    what save writes, so after the reload it shows the default style.
  - The checks start from the default style: a `cc-stretch@inline` entry already in the user's
    settings fails their first step.
