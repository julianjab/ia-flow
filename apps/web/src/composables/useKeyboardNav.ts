// Global console-style keyboard navigation.
//
// Contract:
//   - Wrap any list container with `data-kbd-list` (optionally `data-kbd-list="name"`).
//   - Mark each row/card inside with `data-kbd-item` + `tabindex="0"`.
//   - Enter/Space activates the focused item (native `click()`).
//   - Arrow keys / j / k move focus within the same list.
//   - Home / End jump to first / last.
//   - Esc blurs the current item.
//
// A single window-level listener handles everything so views don't need to
// wire per-list handlers. The listener is a no-op while typing in inputs.

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  return false
}

function itemsOf(list: HTMLElement): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>('[data-kbd-item]')).filter((el) => {
    // Skip items inside a nested list — they belong to the inner list, not this one.
    const owner = el.closest<HTMLElement>('[data-kbd-list]')
    return owner === list
  })
}

function listOf(el: HTMLElement): HTMLElement | null {
  return el.closest<HTMLElement>('[data-kbd-list]')
}

function focusIndex(list: HTMLElement, i: number) {
  const items = itemsOf(list)
  if (!items.length) return
  const idx = ((i % items.length) + items.length) % items.length
  const target = items[idx]
  target.focus()
  // Keep the row visible when jumping across a long list.
  target.scrollIntoView({ block: 'nearest' })
}

function activeItem(): HTMLElement | null {
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return null
  return el.matches('[data-kbd-item]') ? el : null
}

function resolveList(current: HTMLElement | null): HTMLElement | null {
  return current ? listOf(current) : firstVisibleList()
}

function navigate(current: HTMLElement | null, delta: 1 | -1): boolean {
  const list = resolveList(current)
  if (!list) return false
  const items = itemsOf(list)
  const base = current ? items.indexOf(current) : delta > 0 ? -1 : items.length
  focusIndex(list, base + delta)
  return true
}

function jumpToEdge(current: HTMLElement | null, toEnd: boolean): boolean {
  const list = resolveList(current)
  if (!list) return false
  const items = itemsOf(list)
  focusIndex(list, toEnd ? items.length - 1 : 0)
  return true
}

function activate(current: HTMLElement | null): boolean {
  if (!current) return false
  current.click()
  return true
}

function dismiss(current: HTMLElement | null): boolean {
  if (!current) return false
  current.blur()
  return true
}

function dispatchKey(key: string, current: HTMLElement | null): boolean {
  switch (key) {
    case 'ArrowDown':
    case 'j':
      return navigate(current, 1)
    case 'ArrowUp':
    case 'k':
      return navigate(current, -1)
    case 'Home':
      return jumpToEdge(current, false)
    case 'End':
      return jumpToEdge(current, true)
    case 'Enter':
    case ' ':
      return activate(current)
    case 'Escape':
      return dismiss(current)
    default:
      return false
  }
}

function handleKey(ev: KeyboardEvent) {
  if (ev.defaultPrevented) return
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return

  // If focus is inside an input, ignore. Enter/arrows must remain native there.
  if (isTypingTarget(ev.target)) return

  const handled = dispatchKey(ev.key, activeItem())
  if (handled) ev.preventDefault()
}

// Remembered so arrow keys after a click stay in the list the user just
// interacted with (browsers skip focus on click for tabindex=0 non-buttons).
let lastList: HTMLElement | null = null

function firstVisibleList(): HTMLElement | null {
  if (lastList?.isConnected) return lastList
  const lists = Array.from(document.querySelectorAll<HTMLElement>('[data-kbd-list]'))
  for (const l of lists) {
    const rect = l.getBoundingClientRect()
    if (rect.height > 0 && rect.width > 0) return l
  }
  return null
}

function handleFocusIn(ev: FocusEvent) {
  const el = ev.target
  if (!(el instanceof HTMLElement)) return
  const list = listOf(el)
  if (list) lastList = list
}

// Chrome/Firefox skip focus when clicking a tabindex=0 non-button element.
// Force focus so the next arrow key navigates within this row's list.
function handlePointerDown(ev: PointerEvent) {
  const target = ev.target
  if (!(target instanceof HTMLElement)) return
  const item = target.closest<HTMLElement>('[data-kbd-item]')
  if (!item) return
  if (document.activeElement !== item) {
    queueMicrotask(() => item.focus())
  }
}

let installed = false
export function installKeyboardNav() {
  if (installed) return
  installed = true
  window.addEventListener('keydown', handleKey)
  window.addEventListener('focusin', handleFocusIn)
  window.addEventListener('pointerdown', handlePointerDown, true)
}
