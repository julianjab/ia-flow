import AppKit
import Darwin
import SwiftUI

// Barra de menú de ia-flow: levanta, detiene y reinicia web, gateway, runner, Grafana y túneles de julianjab.link.
// Clic en el ícono → popover SwiftUI (Views.swift); clic derecho o ⌥-clic → menú corto. En reposo es un proceso
// que sólo espera eventos (≈ 0 % CPU): la interfaz SwiftUI existe únicamente mientras el popover está abierto
// y el estado se relee cada 3 s sólo en ese momento.
//
// Flags: --status             imprime el estado de cada servicio y sale
//        --screenshot <base>  renderiza el popover (lista y formulario, claro y oscuro) a <base>-*.png y sale
//        --open               abre el popover al arrancar (verificación; con IA_FLOW_MENUBAR_HOME no toca lo real)
//        IA_FLOW_MENUBAR_HOME aísla la config, los logs y los túneles en otra carpeta (pruebas)

let args = CommandLine.arguments

func flagValue(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name) else { return nil }
    return args.dropFirst(i + 1).first.flatMap { $0.hasPrefix("--") ? nil : $0 }
}

/// Hosting view fuera de pantalla → PNG (screencapture no captura la barra de menú ni un popover cerrado).
/// El alto de los ScrollView se calcula tras el primer layout: se deja correr el run loop antes de medir.
func renderPNG(_ model: AppModel, dark: Bool, to path: String) {
    let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    let hosting = NSHostingView(rootView: RootView(model: model))
    hosting.appearance = appearance
    let bg = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: popoverWidth, height: 900))
    bg.material = .popover  // fondo de popover para que el PNG se parezca a lo que se ve en pantalla
    bg.state = .active
    bg.appearance = appearance
    let window = NSWindow(contentRect: bg.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.appearance = appearance
    window.contentView = bg
    hosting.frame = bg.bounds
    bg.addSubview(hosting)
    for _ in 0..<3 {
        RunLoop.main.run(until: Date().addingTimeInterval(0.25))
        let fit = hosting.fittingSize
        window.setContentSize(fit)
        bg.frame = NSRect(origin: .zero, size: fit)
        hosting.frame = bg.bounds
        bg.layoutSubtreeIfNeeded()
    }
    guard let rep = bg.bitmapImageRepForCachingDisplay(in: bg.bounds) else { return }
    bg.cacheDisplay(in: bg.bounds, to: rep)
    if let data = rep.representation(using: .png, properties: [:]) {
        try? data.write(to: URL(fileURLWithPath: path))
        print("captura: \(path) (\(Int(bg.bounds.width))×\(Int(bg.bounds.height)) pt)")
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let popover = NSPopover()
    private let contextMenu = NSMenu()
    private let model = AppModel()
    private var openTimer: Timer?
    /// Con el popover cerrado, la bandeja del runner se relee cada minuto: es lo que alimenta el badge.
    private var badgeTimer: Timer?
    private var badge = 0
    private var signalSources: [DispatchSourceSignal] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let base = flagValue("--screenshot") { return screenshots(base) }

        // pkill, kill, cerrar sesión: pasan por el mismo cierre que «Salir» y detienen lo que levantó la app.
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { NSApp.terminate(nil) }
            source.resume()
            signalSources.append(source)
        }

        model.onChange = { [weak self] in self?.refreshIcon() }
        model.runner.onBadge = { [weak self] count in
            guard let self, self.badge != count else { return }
            self.badge = count
            self.refreshIcon()
        }
        model.runner.refresh()
        badgeTimer = Timer(timeInterval: 60, repeats: true) { [weak self] _ in
            guard let self, !self.popover.isShown else { return }
            self.model.runner.refresh()
        }
        RunLoop.main.add(badgeTimer!, forMode: .common)
        statusItem.button?.target = self
        statusItem.button?.action = #selector(statusClicked(_:))
        statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        popover.behavior = .transient
        popover.animates = true
        popover.delegate = self

        contextMenu.addItem(menuItem("Actualizar", #selector(refreshAction)))
        contextMenu.addItem(menuItem("Editar servicios…", #selector(editAction)))
        contextMenu.addItem(.separator())
        contextMenu.addItem(menuItem("Salir (detiene los procesos que levantó)", #selector(quitAction), key: "q"))
        refreshIcon()
        if args.contains("--open"), let button = statusItem.button {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [self] in showPopover(button) }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        model.services.filter { !$0.isDetached }.forEach { $0.stop() }
        // Dar un respiro a los SIGTERM antes de salir.
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
    }

    private func refreshIcon() {
        statusItem.length = badge > 0 ? NSStatusItem.variableLength : NSStatusItem.squareLength
        statusItem.button?.image = menuBarIcon(running: model.activeCount > 0, badge: badge)
        statusItem.button?.toolTip = badge > 0 ? "ia-flow · \(badge) tareas te esperan en \(model.runner.selected.name)" : "ia-flow"
    }

    // MARK: capturas (verificación visual sin la barra de menú)

    private func screenshots(_ base: String) {
        popoverMaxScroll = 2000  // ver todo el contenido, sin el scroll del popover
        let model = AppModel.fixture()
        for dark in [false, true] { renderPNG(model, dark: dark, to: "\(base)-list-\(dark ? "dark" : "light").png") }
        model.beginForm()
        model.form?.sub = "demo"
        model.form?.portText = "5173"
        model.form?.ports = [(5173, "node"), (4141, "bun"), (3001, "bun"), (3000, "gvproxy")]
        model.form?.notice = .overwriteDNS("demo.julianjab.link")
        for dark in [false, true] { renderPNG(model, dark: dark, to: "\(base)-form-\(dark ? "dark" : "light").png") }
        model.cancelForm()
        model.tab = .runner
        for dark in [false, true] { renderPNG(model, dark: dark, to: "\(base)-runner-\(dark ? "dark" : "light").png") }
        model.runner.query = "funnel"
        for dark in [false, true] { renderPNG(model, dark: dark, to: "\(base)-search-\(dark ? "dark" : "light").png") }
        model.runner.query = ""
        model.runner.screen = .logs
        for dark in [false, true] { renderPNG(model, dark: dark, to: "\(base)-logs-\(dark ? "dark" : "light").png") }
        if let tiff = menuBarIcon(running: true, badge: 3).tiffRepresentation,
           let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: "\(base)-badge.png"))
        }
        exit(0)
    }

    // MARK: popover

    @objc private func statusClicked(_ sender: NSStatusBarButton) {
        let event = NSApp.currentEvent
        if event?.type == .rightMouseUp || event?.modifierFlags.contains(.option) == true {
            if popover.isShown { popover.performClose(nil) }
            statusItem.menu = contextMenu
            sender.performClick(nil)  // muestra el menú contextual
            statusItem.menu = nil
            return
        }
        popover.isShown ? popover.performClose(nil) : showPopover(sender)
    }

    private func showPopover(_ button: NSStatusBarButton) {
        // la jerarquía SwiftUI sólo existe mientras el popover está abierto: en reposo no ocupa RAM
        let host = NSHostingController(rootView: RootView(model: model))
        host.sizingOptions = [.preferredContentSize]
        popover.contentViewController = host
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        NSApp.activate(ignoringOtherApps: true)
        popover.contentViewController?.view.window?.makeKey()
        model.refresh()
        model.runner.refresh()
        if model.tab == .runner, model.runner.screen == .logs { model.runner.pollLogs() }
        // cada 3 s: servicios siempre; el log del server si está abierto; la bandeja cada 6 s si se mira el runner
        var tick = 0
        openTimer = Timer(timeInterval: 3, repeats: true) { [weak self] _ in
            guard let self else { return }
            tick += 1
            self.model.refresh()
            guard self.model.tab == .runner else { return }
            if self.model.runner.screen == .logs { self.model.runner.pollLogs() }
            else if tick % 2 == 0 { self.model.runner.refresh() }
        }
        RunLoop.main.add(openTimer!, forMode: .common)
    }

    func popoverDidClose(_ notification: Notification) {
        openTimer?.invalidate()
        openTimer = nil
        model.cancelForm()
        model.confirm = nil
        model.runner.comment = nil
        popover.contentViewController = nil  // libera la vista SwiftUI
        // devuelve al sistema las páginas que malloc retiene tras destruir la UI (RAM en reposo)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { _ = malloc_zone_pressure_relief(nil, 0) }
    }

    // MARK: menú contextual

    private func menuItem(_ title: String, _ selector: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        item.target = self
        return item
    }

    @objc private func refreshAction() { model.refresh() }
    @objc private func editAction() { model.editConfig() }
    @objc private func quitAction() { model.quit() }
}

// `--icon <px> <ruta>`: escribe el ícono de app como PNG (build.sh arma el .icns con esto). Con el flag el proceso
// termina siempre: si algo falla sale con 1, nunca sigue de largo a abrir la app.
if let i = args.firstIndex(of: "--icon") {
    guard let pixels = args.dropFirst(i + 1).first.flatMap(Int.init), let path = args.dropFirst(i + 2).first else {
        FileHandle.standardError.write(Data("uso: --icon <px> <ruta>\n".utf8))
        exit(1)
    }
    guard let data = appIconPNG(pixels: pixels) else {
        FileHandle.standardError.write(Data("--icon: no se pudo dibujar el ícono a \(pixels) px\n".utf8))
        exit(1)
    }
    do {
        try data.write(to: URL(fileURLWithPath: path))
    } catch {
        FileHandle.standardError.write(Data("--icon: no se pudo escribir \(path): \(error.localizedDescription)\n".utf8))
        exit(1)
    }
    exit(0)
}

// `--status`: imprime el estado de cada servicio y sale (para comprobar sin abrir el menú).
if args.contains("--status") {
    for spec in loadAllSpecs() {
        let service = Service(spec: spec)
        service.syncFromPort()
        print("\(spec.id)\t\(service.state)\(service.isExternal ? " (externo)" : "")")
    }
    exit(0)
}

// Una sola instancia: launchd lanza el binario directo (sin LaunchServices) y podrían quedar dos íconos.
// Con IA_FLOW_MENUBAR_HOME (pruebas aisladas) y en las capturas no aplica.
if ProcessInfo.processInfo.environment["IA_FLOW_MENUBAR_HOME"] == nil, flagValue("--screenshot") == nil,
   let id = Bundle.main.bundleIdentifier,
   NSRunningApplication.runningApplications(withBundleIdentifier: id).contains(where: { $0.processIdentifier != getpid() }) {
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
