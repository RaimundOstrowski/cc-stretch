import type { ClientModule, ClientPointerEvent, ClientSurface, TextProps } from 'claude-code'

import { grow, lengthOf } from './grow'
import { continuationOf, isMarkup, layout, link, linkAt, lit, targetsIn, tint, widthOf } from './layout'
import type { Row, Run, Toggle } from './layout'
import { ADDED, addedKeyOf, canDeepen, closeAfter, isAdded, isLinkable, KEY_SEPARATOR, parse, sectionOf, stretches, withAdded } from './parse'
import { DEFAULT_LOOK, drawsHighlight, lookProps } from './look'
import type { Hex } from './contrast'
import type { DrawnLook } from './look'
import type { Deepening, Query, Segment, Stretch } from './parse'

// Draws one paragraph of a reply that holds stretches. It runs where the reader's screen draws it,
// so a press answers at once and the growth moves on the screen's own frame clock. What the reader
// opens is posted to the hooks module, which keeps it across redraws, notes it for Claude and picks
// its colour. A press on ✦ posts the section it asks more on; the hooks module runs the query and
// hands the answer back in `deepened`, where it opens in place.

/**
 * The colours of an open stretch: of the words it added (faded unless it is the newest) and of its
 * closer, which never fades, as a faded closer reads as disabled.
 */
export type Tint = { words: string; closer: string }

/** A stretch the reader asked to open or close from the keyboard, numbered so each ask acts once. */
type Ask = { key: string; action: Toggle; n: number }

/** While letters show: whether typing one opens or closes, and the letter of each stretch they cover. */
type Letters = { action: Toggle; keys: Record<string, string> }

/**
 * The paragraph, the stretches the reader already has open in it, the tint of each, the last ask, its
 * letters, how pressable phrases look, under the tinted highlight each stretch's own highlight, by
 * key, in place of the look's, what ✦ asked for each stretch, and the background of the section a
 * press on ✦ would send.
 */
export type ReplyProps = {
  text: string
  open: string[]
  tints: Record<string, Tint>
  ask: Ask | null
  letters: Letters | null
  look?: DrawnLook
  highlights: Record<string, Hex>
  deepened: Record<string, Deepening>
  lit: string
}

/**
 * What the instance posts to the hooks module when the open stretches change, with the stretch the
 * reader just opened: its short form for the note to Claude, its key for its colour. `queries` are
 * the sections ✦ asked more on whose answer has not come back, sent again with each post so a post
 * the next one replaced loses none; `hover` is the stretch whose ✦ the pointer is on.
 */
export type ReplyPost = { open: string[]; opened?: { short: string; key: string }; queries?: Query[]; hover?: string | null }

/** What the instance posts to the hooks module when the reader drags across its text: the text, for the clipboard. */
export type CopyPost = { copy: string }

/**
 * A run as drawn: a letter over the first character of a short form or a «, or the rest of that
 * text after it; or text the reader dragged across.
 */
type DrawnRun = Run & { isLetter?: true; isAfterLetter?: true; isSelected?: true }

type Growth = { key: string; isOpening: boolean; progress: number; duration: number }
type Cell = { x: number; y: number }
/**
 * Text the reader dragged across: from the cell the press went down on to the one under the pointer.
 * A word picked by a double-click covers both its ends, even when they are the same cell.
 */
type Selection = { anchor: Cell; head: Cell; isDragging: boolean; isWord?: true }
/**
 * One cell a double-click looks through for a word: what it shows, and where. `startsApart` marks
 * the first cell of a row that no word runs onto from the row before.
 */
type WordCell = { segment: string; x: number; y: number; width: number; startsApart?: true }
/**
 * What is open, what is growing, the number of the last ask acted on, what the reader selected, the
 * queries ✦ sent whose answer is not back, the stretch whose ✦ the pointer is on, the spinner's
 * step, and how many presses on ✦ this instance saw.
 */
type State = {
  open: string[]
  growth: Growth | null
  asked: number
  selection: Selection | null
  queries: Query[]
  hover: string | null
  spin: number
  count: number
}

const FRAME_MS = 16
// Two presses make a double-click when the second comes less than this long after the first and at
// most this many cells from it, across and down: the limits of Claude Code 2.1.303's own double-click,
// so a paragraph that holds a stretch answers like the paragraphs around it.
const DOUBLE_CLICK_MS = 500
const DOUBLE_CLICK_CELLS = 1
// What a double-click takes as one word: Claude Code 2.1.303's own word characters, and `#` as well,
// so that `#12806` comes out whole.
const WORD = /[\p{L}\p{N}_/.\-+~\\#]/u
// What a URL is made of: as Claude Code 2.1.303's own double-click does, a URL is taken from its
// scheme on, whatever style it is drawn in.
const IN_URL = /^(?![<>"'`])[!-~]$/
// What a URL does not end on: the punctuation after it, and a closing bracket it does not open.
const AFTER_URL = '.,;:!?'
const OPENERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// ✦ and the answers it brings are drawn in the theme's suggestion colour, apart from the colours
// opened stretches take in turn, as they are words of a later query, not of the reply.
const ANSWER: Tint = { words: 'suggestion', closer: 'suggestion' }
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
/** Frames each spinner glyph is shown for. */
const SPIN_FRAMES = 5

// What the last call drew, per instance, so a press is matched against the rows on screen: the rows
// as laid out, and as drawn with any letters over them; and what ✦ asked, for the frame clock.
const drawn = new WeakMap<object, { laid: Row[]; rows: Row[]; segments: Segment[]; deepened: Record<string, Deepening> }>()
// The last ask each instance was handed, acted on at its next frame rather than while drawing.
const asks = new WeakMap<object, Ask>()
// The last press each instance saw, where and when it went down, so the next press soon after and
// close by makes a double-click; a quick third press, measured from the second, picks the word
// again. It is dropped when its release lands on another cell, so two quick drags from one cell
// stay two drags, and when a stretch opens or closes, which ends a double-click begun before it.
const presses = new WeakMap<object, Cell & { at: number }>()
// Frames each instance drew while a query ran, which turn its spinner.
const frames = new WeakMap<object, number>()

const Reply: ClientModule<ReplyProps, State> = (props, surface) => {
  const { Box, Link, Text } = surface.elements
  // An ask made before this instance was drawn is not acted on again.
  const fresh: State = { open: props.open, growth: null, asked: props.ask?.n ?? 0, selection: null, queries: [], hover: null, spin: 0, count: 0 }
  if (surface.state === undefined) {
    surface.setState(fresh)
    surface.onPointer(event => pointer(surface, event))
    surface.every(FRAME_MS, () => tick(surface))
  }
  // As of Claude Code 2.1.302 a paragraph an older plugin version drew stays on screen after
  // /reload-plugins, and this code is handed its old props, without the ask, the letters, the look,
  // the highlights or what ✦ asked.
  const ask = props.ask ?? null
  const letters = props.letters ?? null
  if (ask !== null) asks.set(surface, ask)
  const deepened = props.deepened ?? {}
  const segments = withAdded(parse(props.text), deepened)
  const state = settle(surface, surface.state ?? fresh, segments, deepened)
  // Read through Maps, which hold own keys only: a stretch keyed `constructor` must not find Object's.
  const tints = new Map(Object.entries(props.tints))
  const laid = layout(compose(segments, state, tints, deepened), surface.columns > 0 ? surface.columns : 80)
  const lettering = lettered(laid, letters)
  drawn.set(surface, { laid, rows: lettering, segments, deepened })
  const rows = state.selection === null ? lettering : selected(lettering, laid, state.selection)
  const look = props.look ?? DEFAULT_LOOK
  const highlights = new Map(Object.entries(props.highlights ?? {}))
  const lookFor = (run: DrawnRun): DrawnLook => {
    const highlight = run.link && highlights.get(run.link.key)
    return highlight === undefined ? look : { ...look, highlight }
  }

  return (
    <Box flexDirection="column">
      {rows.map(row => (
        <Text wrap="truncate">
          {row.length === 0
            ? ' '
            : row.map(run => {
                const piece = <Text {...styleOf(run, lookFor(run), props.lit)}>{run.text}</Text>
                return run.href === undefined ? piece : <Link href={run.href}>{piece}</Link>
              })}
        </Text>
      ))}
    </Box>
  )
}

export default Reply

/**
 * The state once each section ✦ asked more on whose query ended is let go: an answer opens in
 * place, growing as a press opens a stretch.
 */
function settle(surface: ClientSurface<State>, state: State, segments: Segment[], deepened: Record<string, Deepening>): State {
  const ended = state.queries.filter(({ key, ask }) => {
    const asked = deepened[key]
    return asked?.status === 'done' || (asked?.status === 'failed' && asked.ask === ask)
  })
  if (ended.length === 0) return state
  const queries = state.queries.filter(query => !ended.includes(query))
  const answered = ended.filter(query => deepened[query.key]?.status === 'done').map(query => addedKeyOf(query.key))
  const open = [...state.open.filter(key => !answered.includes(key)), ...answered]
  const newest = stretches(segments).find(one => one.key === answered.at(-1))
  const growth = newest?.long === undefined ? state.growth : { key: newest.key, isOpening: true, progress: 0, duration: durationOf(newest.long) }
  const next = { ...state, open, queries, growth }
  surface.setState(next)
  surface.post({ open, queries } satisfies ReplyPost)

  return next
}

/**
 * The paragraph as the reader sees it now: closed stretches as pressable short forms, open ones in
 * full then a «, the words each added in its tint. An open stretch with nothing left inside it to
 * open ends in ✦, or in a spinner while its query runs.
 */
function compose(segments: Segment[], state: State, tints: ReadonlyMap<string, Tint>, deepened: Record<string, Deepening>): string {
  const write = (parts: Segment[]): string => parts.map(part => (typeof part === 'string' ? part : draw(part))).join('')
  const draw = (stretch: Stretch): string => {
    if (stretch.long === undefined || !stretch.isClosed) return stretch.short
    // A short form over several lines is drawn open, or as written when its long form is empty.
    if (!isLinkable(stretch)) return stretch.long.length === 0 ? stretch.short : write(stretch.long)
    const isAnswer = isAdded(stretch.key)
    const colours = isAnswer ? ANSWER : tints.get(stretch.key)
    const paint = (word: string) => (colours === undefined || isMarkup(word) ? word : tint(colours.words, word))
    // An answer keeps its ✦ in front, where it stood closed, and grows after it.
    const lead = isAnswer ? `${tint(ANSWER.words, ADDED)} ` : ''
    if (state.growth?.key === stretch.key) return lead + grow(stretch.short, stretch.long, easeInOut(state.growth.progress), draw, paint)
    if (!state.open.includes(stretch.key)) {
      const opener = link('open', stretch.key, stretch.short)
      return isAnswer ? tint(ANSWER.words, opener) : opener
    }
    const closer = link('close', stretch.key, '«')
    const long = lead + grow(stretch.short, stretch.long, 1, draw, paint)
    return closeAfter(state.hover === stretch.key ? lit(long) : long, (colours === undefined ? closer : tint(colours.closer, closer)) + control(stretch), '\n')
  }
  // The spinner stays pressable: the hooks module asks nothing while the query runs, and asks again
  // for one a reload cut.
  const control = (stretch: Stretch): string => {
    if (!canDeepen(stretch, state.open)) return ''
    const label = isQuerying(state, deepened, stretch.key) ? (SPINNER[state.spin % SPINNER.length] ?? ADDED) : ADDED
    return ` ${link('deepen', stretch.key, label)}`
  }

  return write(segments)
}

/** Whether a query ✦ asked for stretch `key` is running. */
function isQuerying(state: State, deepened: Record<string, Deepening>, key: string): boolean {
  return state.queries.some(query => query.key === key) || deepened[key]?.status === 'running'
}

/**
 * The rows with each letter drawn over the first character of what a press on its stretch acts on,
 * its short form or its «, so nothing on screen moves; the rest of that text is marked.
 */
function lettered(rows: Row[], letters: Letters | null): DrawnRun[][] {
  if (letters === null) return rows
  const keys = new Map(Object.entries(letters.keys))
  const done = new Set<string>()
  return rows.map(row =>
    row.flatMap((run): DrawnRun[] => {
      const { link } = run
      const letter = link?.action === letters.action ? keys.get(link.key) : undefined
      if (link === undefined || letter === undefined) return [run]
      if (done.has(link.key)) return [{ ...run, isAfterLetter: true }]
      done.add(link.key)
      const first = GRAPHEMES.segment(run.text).containing(0)?.segment
      if (first === undefined) return [run]
      const rest = run.text.slice(first.length)
      // A letter takes one cell, so a wide first character keeps its second cell as a space.
      const cover: DrawnRun = { ...run, text: widthOf(first) > 1 ? `${letter} ` : letter, isLetter: true }
      return rest === '' ? [cover] : [cover, { ...run, text: rest, isAfterLetter: true }]
    }),
  )
}

/**
 * A press on a short form or a « opens or closes its stretch, and one on ✦ asks Claude for more. As
 * of Claude Code 2.1.302 a Client holds the pointer from a press until its release and the transcript
 * selects nothing meanwhile, so a drag from anywhere else selects here: the cells it crosses are
 * highlighted, and on release their text goes to the clipboard. A double-click selects here too,
 * taking the URL or word under it at once.
 */
function pointer(surface: ClientSurface<State>, event: ClientPointerEvent) {
  const state = surface.state
  const shown = drawn.get(surface)
  if (state === undefined || shown === undefined) return
  const { selection } = state
  if (event.type === 'down' && event.button === 'left') {
    const target = linkAt(shown.rows, event.x, event.y)
    if (target?.action === 'deepen') {
      query(surface, target.key)
      return
    }
    if (target !== undefined && openOrClose(surface, target.action, target.key)) return
    const cell = clamped(shown.rows, event)
    const at = performance.now()
    const last = presses.get(surface)
    const isDouble =
      last !== undefined &&
      at - last.at < DOUBLE_CLICK_MS &&
      Math.abs(cell.x - last.x) <= DOUBLE_CLICK_CELLS &&
      Math.abs(cell.y - last.y) <= DOUBLE_CLICK_CELLS
    const word = isDouble ? wordAt(shown.laid, cell) : undefined
    presses.set(surface, { ...cell, at })
    if (word !== undefined) {
      const picked: Selection = { ...word, isDragging: false, isWord: true }
      surface.setState({ ...state, selection: picked })
      const text = textIn(shown.laid, picked)
      if (text !== '') surface.post({ copy: text } satisfies CopyPost)
      return
    }
    surface.setState({ ...state, selection: { anchor: cell, head: cell, isDragging: true } })
    return
  }
  // The pointer resting on ✦ lights the section a press would send.
  if (event.type === 'move' && event.button === undefined) {
    const target = linkAt(shown.rows, event.x, event.y)
    hoverOn(surface, state, target?.action === 'deepen' && !isQuerying(state, shown.deepened, target.key) ? target.key : null)
    return
  }
  // A selection left on screen goes once the pointer moves off the paragraph, and so does the light:
  // as of Claude Code 2.1.302 a press elsewhere does not reach this instance to take them down.
  if (event.type === 'leave') {
    hoverOn(surface, state, null, selection?.isDragging === false ? null : selection)
    return
  }
  if (selection?.isDragging !== true) return
  if (event.type === 'move') {
    const head = clamped(shown.rows, event)
    if (head.x !== selection.head.x || head.y !== selection.head.y) surface.setState({ ...state, selection: { ...selection, head } })
    return
  }
  if (event.type !== 'up') return
  const text = textIn(shown.laid, selection)
  if (text !== '' || selection.anchor.x !== selection.head.x || selection.anchor.y !== selection.head.y) presses.delete(surface)
  // A click (a press that moved nowhere) takes a selection down, and so does a release off the
  // paragraph, which as of Claude Code 2.1.302 no leave follows.
  const isOff = event.x < 0 || event.y < 0 || event.x >= surface.columns || event.y >= shown.rows.length
  surface.setState({ ...state, selection: text === '' || isOff ? null : { ...selection, isDragging: false } })
  if (text !== '') surface.post({ copy: text } satisfies CopyPost)
}

/**
 * Lights the section whose ✦ the pointer is on, stretch `key`, or none, and tells the hooks module,
 * which says what a press does; `selection` is what the reader keeps selected meanwhile.
 */
function hoverOn(surface: ClientSurface<State>, state: State, key: string | null, selection: Selection | null = state.selection): void {
  if (key === state.hover && selection === state.selection) return
  surface.setState({ ...state, hover: key, selection })
  if (key !== state.hover) surface.post({ open: state.open, queries: state.queries, hover: key } satisfies ReplyPost)
}

/**
 * Asks Claude for more on stretch `key`: the section it holds is posted to the hooks module, which
 * runs the query. A press while that query runs asks nothing more.
 */
function query(surface: ClientSurface<State>, key: string): void {
  const state = surface.state
  const shown = drawn.get(surface)
  presses.delete(surface)
  if (state === undefined || shown === undefined || state.queries.some(query => query.key === key)) return
  const section = sectionOf(shown.segments, key)
  if (section === undefined) return
  // A press is named by the count of presses on ✦ here and the time, so one after a remount differs too.
  const queries = [...state.queries, { ...section, ask: Date.now() * 100 + (state.count % 100) }]
  surface.setState({ ...state, queries, hover: null, count: state.count + 1, selection: null })
  surface.post({ open: state.open, queries, hover: null } satisfies ReplyPost)
}

/** The cell under the pointer, kept to the rows drawn: above them is their start, below them their end. */
function clamped(rows: Row[], { x, y }: Cell): Cell {
  if (y < 0) return { x: 0, y: 0 }
  if (y >= rows.length) return { x: Number.POSITIVE_INFINITY, y: Math.max(0, rows.length - 1) }
  return { x: Math.max(0, x), y }
}

/** The selection's first and last cells in reading order, both selected; none when it covers no cell. */
function span({ anchor, head, isWord }: Selection): { from: Cell; to: Cell } | undefined {
  if (anchor.x === head.x && anchor.y === head.y && isWord !== true) return undefined
  const isForward = anchor.y < head.y || (anchor.y === head.y && anchor.x < head.x)
  return isForward ? { from: anchor, to: head } : { from: head, to: anchor }
}

/**
 * The URL or the word around cell `at` as a selection's two ends, its first and last cells, which a
 * line wrapped inside it puts on different rows; none when the cell is in no URL and holds no word
 * character, so a double-click on a space or a comma picks nothing.
 */
function wordAt(rows: Row[], at: Cell): { anchor: Cell; head: Cell } | undefined {
  const cells = cellsIn(rows)
  const hit = cells.findIndex(cell => cell.y === at.y && at.x >= cell.x && at.x < cell.x + Math.max(1, cell.width))
  const ends = urlAround(cells, hit) ?? wordAround(cells, hit)
  const first = ends && cells[ends[0]]
  const last = ends && cells[ends[1]]
  if (first === undefined || last === undefined) return undefined
  return { anchor: { x: first.x, y: first.y }, head: { x: last.x + Math.max(1, last.width) - 1, y: last.y } }
}

/**
 * Every cell of `rows` in reading order, without the lead a wrapped line's later rows start with. A
 * row starts apart from the one before unless a line wrapped onto it inside a word.
 */
function cellsIn(rows: Row[]): WordCell[] {
  const cells: WordCell[] = []
  rows.forEach((row, y) => {
    const continuation = continuationOf(row)
    let x = 0
    for (const run of row) {
      for (const { segment } of GRAPHEMES.segment(run.text)) {
        const width = widthOf(segment)
        if (x >= (continuation?.lead ?? 0)) {
          const isApart = cells.at(-1)?.y !== y && continuation?.join !== ''
          cells.push({ segment, x, y, width, ...(isApart && { startsApart: true }) })
        }
        x += width
      }
    }
  })
  return cells
}

/** The first and last of the cells around `hit` that `isIn` holds for, within one line. */
function around(cells: WordCell[], hit: number, isIn: (cell: WordCell | undefined) => boolean): [number, number] {
  let first = hit
  let last = hit
  while (cells[first]?.startsApart !== true && isIn(cells[first - 1])) first -= 1
  while (cells[last + 1]?.startsApart !== true && isIn(cells[last + 1])) last += 1
  return [first, last]
}

/**
 * The URL around cell `hit`: its run of URL characters, cut at the last scheme at or before it and
 * the next scheme after it, less what a URL does not end on; none when `hit` is in no URL.
 */
function urlAround(cells: WordCell[], hit: number): [number, number] | undefined {
  const isInUrl = (cell: WordCell | undefined) => IN_URL.test(cell?.segment ?? '')
  if (!isInUrl(cells[hit])) return undefined
  const [first, last] = around(cells, hit, isInUrl)
  // Each cell of the run holds one character, so a place in its text is a place among its cells.
  const text = cells.slice(first, last + 1).map(cell => cell.segment).join('')
  const offset = hit - first
  const starts = [...text.matchAll(/(?:https?|file):\/\//g)].map(match => match.index)
  const from = starts.findLast(start => start <= offset)
  if (from === undefined) return undefined
  let url = text.slice(from, starts.find(start => start > offset))
  while (url !== '') {
    const end = url.slice(-1)
    const opener = OPENERS[end]
    const isUnopened = opener !== undefined && url.split(end).length > url.split(opener).length
    if (!AFTER_URL.includes(end) && !isUnopened) break
    url = url.slice(0, -1)
  }
  return offset < from + url.length ? [first + from, first + from + url.length - 1] : undefined
}

/**
 * The run of word characters around cell `hit`, without the full stops it ends on unless it is
 * nothing else; none when `hit` holds no word character.
 */
function wordAround(cells: WordCell[], hit: number): [number, number] | undefined {
  const isWord = (cell: WordCell | undefined) => WORD.test(cell?.segment ?? '')
  if (!isWord(cells[hit])) return undefined
  const [first, last] = around(cells, hit, isWord)
  const isStop = (at: number) => cells[at]?.segment === '.'
  let end = last
  while (end > first && isStop(end)) end -= 1
  return [first, isStop(end) ? last : end]
}

/**
 * The columns of `row`, row `y`, a selection covers, from the first to the last, both included. A row
 * a line wrapped onto is covered after its lead, as the line itself had none there.
 */
function columnsOf(y: number, row: Row, { from, to }: { from: Cell; to: Cell }): [number, number] | undefined {
  if (y < from.y || y > to.y) return undefined
  const lead = continuationOf(row)?.lead ?? 0
  return [Math.max(y === from.y ? from.x : 0, lead), y === to.y ? to.x : Number.POSITIVE_INFINITY]
}

/**
 * Each run of `rows` with the part a selection covers split out and marked, character by character:
 * the cells `textIn` copies. `laid` is `rows` before letters were drawn over them, which is where a
 * wrapped row's lead is recorded.
 */
function selected(rows: DrawnRun[][], laid: Row[], selection: Selection): DrawnRun[][] {
  const covered = span(selection)
  if (covered === undefined) return rows
  return rows.map((row, y) => {
    const columns = columnsOf(y, laid[y] ?? [], covered)
    if (columns === undefined) return row
    const [first, last] = columns
    const out: DrawnRun[] = []
    let at = 0
    for (const run of row) {
      let piece: DrawnRun | undefined
      for (const { segment } of GRAPHEMES.segment(run.text)) {
        const isSelected = at >= first && at <= last
        if (piece !== undefined && (piece.isSelected === true) === isSelected) piece.text += segment
        else {
          piece = { ...run, text: segment, ...(isSelected && { isSelected: true }) }
          out.push(piece)
        }
        at += widthOf(segment)
      }
    }
    return out
  })
}

/**
 * The text a selection covers, as the reader would paste it: a line wrapped over several rows joined
 * back into one, without the lead its later rows start with, and each line's trailing spaces gone.
 */
function textIn(rows: Row[], selection: Selection): string {
  const covered = span(selection)
  if (covered === undefined) return ''
  let text = ''
  for (let y = covered.from.y; y <= covered.to.y; y += 1) {
    const row = rows[y] ?? []
    const [start, last] = columnsOf(y, row, covered) ?? [0, Number.POSITIVE_INFINITY]
    const continuation = continuationOf(row)
    let piece = ''
    let at = 0
    for (const run of row) {
      for (const { segment } of GRAPHEMES.segment(run.text)) {
        if (at >= start && at <= last) piece += segment
        at += widthOf(segment)
      }
    }
    if (y > covered.from.y) text = continuation === undefined ? `${text.trimEnd()}\n` : `${text}${continuation.join}`
    text += piece
  }

  return text.trimEnd()
}

/**
 * Opens or closes stretch `key` as a press on it does; false when no link on screen does that, as
 * for a letter the hooks gave a stretch still growing open, whose « is not drawn yet.
 */
function openOrClose(surface: ClientSurface<State>, action: Toggle, key: string, asked?: number): boolean {
  const state = surface.state
  const shown = drawn.get(surface)
  if (state === undefined || shown === undefined || !hasLink(shown.rows, action, key)) return false

  // A stretch still shrinking when another press lands is closed at once, so what can be pressed is
  // judged without it: a press inside it, or a letter put up before it closed, does nothing.
  const open = state.growth !== null && !state.growth.isOpening ? closed(state.open, state.growth.key) : state.open
  const stretch = targetsIn(shown.segments, open, action).find(one => one.key === key)
  if (stretch?.long === undefined) return false
  const duration = durationOf(stretch.long)
  const acted = asked ?? state.asked
  if (action === 'open') {
    const next = [...open.filter(k => k !== stretch.key), stretch.key]
    surface.setState({ ...state, open: next, growth: { key: stretch.key, isOpening: true, progress: 0, duration }, asked: acted, selection: null })
    // An answer is told to Claude as what ✦ added, not as a stretch the reader opened.
    const opened = isAdded(stretch.key) ? undefined : { short: stretch.short.trim(), key: stretch.key }
    surface.post({ open: next, queries: state.queries, ...(opened && { opened }) } satisfies ReplyPost)
  } else {
    surface.setState({ ...state, open, growth: { key: stretch.key, isOpening: false, progress: 1, duration }, asked: acted, selection: null })
  }
  presses.delete(surface)

  return true
}

function tick(surface: ClientSurface<State>) {
  const state = surface.state
  if (state === undefined) return
  const ask = asks.get(surface)
  if (ask !== undefined && ask.n > state.asked) {
    // The ask is spent with no change when its stretch cannot be pressed for it.
    if (!openOrClose(surface, ask.action, ask.key, ask.n)) surface.setState({ ...state, asked: ask.n })
    return
  }
  if (state.growth === null) {
    // The spinner of a running query turns while nothing grows.
    const deepened = drawn.get(surface)?.deepened ?? {}
    if (state.queries.length === 0 && !Object.values(deepened).some(asked => asked.status === 'running')) return
    const count = (frames.get(surface) ?? 0) + 1
    frames.set(surface, count)
    if (count % SPIN_FRAMES === 0) surface.setState({ ...state, spin: state.spin + 1 })
    return
  }
  const { growth } = state
  const progress = growth.progress + ((growth.isOpening ? 1 : -1) * FRAME_MS) / growth.duration
  if (progress > 0 && progress < 1) {
    surface.setState({ ...state, growth: { ...growth, progress } })
    return
  }
  // A shrunk stretch, and every stretch inside it, leaves the open list as its growth ends.
  const open = growth.isOpening ? state.open : closed(state.open, growth.key)
  surface.setState({ ...state, open, growth: null })
  if (!growth.isOpening) surface.post({ open, queries: state.queries } satisfies ReplyPost)
}

/** Whether `rows` draw a link that does `action` to stretch `key`. */
function hasLink(rows: Row[], action: Toggle, key: string): boolean {
  return rows.some(row => row.some(run => run.link?.action === action && run.link.key === key))
}

function closed(open: string[], key: string): string[] {
  return open.filter(k => k !== key && !k.startsWith(`${key}${KEY_SEPARATOR}`))
}

function durationOf(long: Segment[]): number {
  return 1000 * Math.min(1.4, 0.45 + lengthOf(long) / 70)
}

function styleOf(run: DrawnRun, look: DrawnLook, background: string | undefined): TextProps {
  // ✦ runs a query rather than showing words already there, so it is not drawn as a phrase to press:
  // bold, in the colour its answer will take, whatever the look.
  const isDeepen = run.link?.action === 'deepen'
  // A phrase a press acts on carries the look: underlined in the text's own colour by default,
  // leaving colour to code, to the words a click added and to a hyperlink inside the phrase. A
  // closer is tinted like those words.
  const isPlainText = !run.tint && !run.code && run.href === undefined
  // While a letter covers the phrase, the rest of it keeps a highlight drawn on it, so a tinted one
  // still shows the colour the stretch opens in; any other part is drawn in inverse text on the
  // permission colour, underlined whatever the look.
  const isOnPermission = run.isAfterLetter && !drawsHighlight(look, isPlainText)
  const looked = run.link && !isDeepen && !run.isLetter && !isOnPermission ? lookProps(look, isPlainText, run.dim) : undefined
  return {
    ...(run.bold && { bold: true }),
    ...(run.italic && { italic: true }),
    ...(run.underline && { underline: true }),
    // A pressable run's own dim, such as a link target's, is drawn by lookProps, which knows the highlight.
    ...(run.dim && looked === undefined && { dimColor: true }),
    ...(run.tint && { color: run.tint }),
    ...(run.code && { color: 'permission' }),
    ...(run.link && !isDeepen && (looked ?? { underline: true })),
    // A hyperlink is underlined in the suggestion colour, so it is not read as a stretch to press.
    ...(run.href !== undefined && { underline: true, color: 'suggestion' }),
    ...(isDeepen && { color: ANSWER.words, bold: true }),
    // The section a press on ✦ would send is lit on a background a step off the terminal's own.
    ...(run.lit && background !== undefined && { backgroundColor: background }),
    ...(isOnPermission && { color: 'inverseText', backgroundColor: 'permission' }),
    // A letter is drawn bold in inverse text on the theme's error colour.
    ...(run.isLetter && { color: 'inverseText', backgroundColor: 'error', bold: true }),
    // Text the reader dragged across is drawn inverse, as a terminal draws its own selection.
    ...(run.isSelected && { inverse: true }),
  }
}

function easeInOut(k: number): number {
  return k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2
}
