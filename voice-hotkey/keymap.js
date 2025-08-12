export const KEYS = [
  { label: 'Ctrl', svgId: 'key-ctrl-left', aliases: ['control', 'ctrl', '컨트롤'] },
  { label: 'Ctrl', svgId: 'key-ctrl-right', aliases: ['control', 'ctrl', '컨트롤'] },
  { label: 'Alt', svgId: 'key-alt-left', aliases: ['option', 'alt', '알트'] },
  { label: 'Alt', svgId: 'key-alt-right', aliases: ['option', 'alt', '알트'] },
  { label: 'Shift', svgId: 'key-shift-left', aliases: ['shift', '쉬프트'] },
  { label: 'Shift', svgId: 'key-shift-right', aliases: ['shift', '쉬프트'] },
  { label: 'Win', svgId: 'key-win', aliases: ['windows', 'window', 'win', '윈도우', '윈키'] },
  { label: 'Cmd', svgId: 'key-cmd', aliases: ['command', 'cmd', '⌘', '커맨드'] },
  { label: 'W', svgId: 'key-w' },
  { label: 'T', svgId: 'key-t' },
  { label: 'R', svgId: 'key-r' },
  { label: 'F', svgId: 'key-f' },
  { label: 'C', svgId: 'key-c' },
  { label: 'V', svgId: 'key-v' },
  { label: 'Z', svgId: 'key-z' },
  { label: 'S', svgId: 'key-s' }
];

export const ALIASES = {
  control: 'Ctrl', ctrl: 'Ctrl', 컨트롤: 'Ctrl',
  command: 'Cmd', cmd: 'Cmd', '⌘': 'Cmd', 커맨드: 'Cmd',
  option: 'Alt', alt: 'Alt', 알트: 'Alt',
  shift: 'Shift', 쉬프트: 'Shift',
  windows: 'Win', window: 'Win', win: 'Win', 윈도우: 'Win', 윈키: 'Win',
  '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight'
};

export const COMMON_INTENTS = {
  'close tab': ['Ctrl', 'W'],
  'new tab': ['Ctrl', 'T'],
  'refresh': ['Ctrl', 'R'],
  'find': ['Ctrl', 'F'],
  'copy': ['Ctrl', 'C'],
  'paste': ['Ctrl', 'V'],
  'undo': ['Ctrl', 'Z'],
  'save': ['Ctrl', 'S']
};

export const OS_OVERRIDES = {
  macos: {
    'close tab': ['Cmd', 'W'],
    'new tab': ['Cmd', 'T'],
    'refresh': ['Cmd', 'R'],
    'find': ['Cmd', 'F'],
    'copy': ['Cmd', 'C'],
    'paste': ['Cmd', 'V'],
    'undo': ['Cmd', 'Z'],
    'save': ['Cmd', 'S']
  }
};
