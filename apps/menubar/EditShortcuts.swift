import AppKit

// ⌘X ⌘C ⌘V ⌘A ⌘Z ⇧⌘Z en los campos del popover. La app corre como `.accessory` mientras sólo está el popover, y
// AppKit no le pasa los atajos al `mainMenu` (el menú Edición sólo sirve con la ventana): sin esto no se podía pegar
// en el buscador ni en la caja del asistente. Se escuchan las teclas de la app y, si son de edición y caen en una de
// sus ventanas (el popover o la ventana), van al primer responder (el editor del campo) como la acción del menú.

enum EditShortcuts {
    /// La acción de edición de una tecla con ⌘ (sin ⌃ ni ⌥), o nil.
    static func action(key: String, flags: NSEvent.ModifierFlags) -> Selector? {
        let mods = flags.intersection(.deviceIndependentFlagsMask)
        guard mods.contains(.command), !mods.contains(.control), !mods.contains(.option) else { return nil }
        let shift = mods.contains(.shift)
        switch key.lowercased() {
        case "x" where !shift: return #selector(NSText.cut(_:))
        case "c" where !shift: return #selector(NSText.copy(_:))
        case "v" where !shift: return #selector(NSText.paste(_:))
        case "a" where !shift: return #selector(NSText.selectAll(_:))
        case "z": return shift ? Selector(("redo:")) : Selector(("undo:"))
        default: return nil
        }
    }

    private static var monitor: Any?

    /// Una vez al arrancar: `isOwnWindow` dice si la ventana del evento es del menú (popover o ventana).
    static func install(isOwnWindow: @escaping (NSWindow?) -> Bool) {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard isOwnWindow(event.window),
                  let selector = action(key: event.charactersIgnoringModifiers ?? "", flags: event.modifierFlags)
            else { return event }
            return NSApp.sendAction(selector, to: nil, from: event.window) ? nil : event
        }
    }
}
