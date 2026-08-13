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

function handleKey(ev: KeyboardEvent) {
  if (ev.defaultPrevented) return
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return

  const typing = isTypingTarget(ev.target)

  // If focus is inside an input, ignore. Enter/arrows must remain native there.
  if (typing) return

  const current = activeItem()

  switch (ev.key) {
    case 'ArrowDown':
    case 'j': {
      const list = current ? listOf(current) : firstVisibleList()
      if (!list) return
      const items = itemsOf(list)
      const i = current ? items.indexOf(current) : -1
      focusIndex(list, i + 1)
      ev.preventDefault()
      return
    }
    case 'ArrowUp':
    case 'k': {
      const list = current ? listOf(current) : firstVisibleList()
      if (!list) return
      const items = itemsOf(list)
      const i = current ? items.indexOf(current) : items.length
      focusIndex(list, i - 1)
      ev.preventDefault()
      return
    }
    case 'Home': {
      const list = current ? listOf(current) : firstVisibleList()
      if (!list) return
      focusIndex(list, 0)
      ev.preventDefault()
      return
    }
    case 'End': {
      const list = current ? listOf(current) : firstVisibleList()
      if (!list) return
      const items = itemsOf(list)
      focusIndex(list, items.length - 1)
      ev.preventDefault()
      return
    }
    case 'Enter':
    case ' ': {
      if (!current) return
      current.click()
      ev.preventDefault()
      return
    }
    case 'Escape': {
      if (!current) return
      current.blur()
      ev.preventDefault()
      return
    }
  }
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
