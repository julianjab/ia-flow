import AppKit
import Darwin

// Barra de menú de ia-flow: levanta, detiene y reinicia web, gateway y runner.
// Sin ventanas ni Dock; un proceso nativo que sólo espera eventos (≈ 0 % CPU en reposo).

struct ServiceSpec: Codable {
    let id: String
    let name: String
    let command: String
    let cwd: String
    let port: Int?
    let url: String?
    var env: [String: String]?
    /// Con `stopCommand` el servicio es "detached": `command` lo deja corriendo por su cuenta
    /// (launchd, un contenedor) y el estado sale del puerto, no de un proceso hijo.
    var stopCommand: String?
}

let home = FileManager.default.homeDirectoryForCurrentUser.path
let configDir = "\(home)/.config/ia-flow-menubar"
let logDir = "\(home)/.local/state/ia-flow/menubar"

func defaultServices(root: String) -> [ServiceSpec] {
    [
        ServiceSpec(id: "web", name: "Web", command: "bun run dev", cwd: root, port: 5173, url: "http://localhost:5173", env: nil, stopCommand: nil),
        ServiceSpec(id: "gateway", name: "Gateway", command: "bun run gateway", cwd: root, port: 4141, url: nil, env: nil, stopCommand: nil),
        ServiceSpec(id: "runner", name: "Runner", command: "bun run runner:serve", cwd: root, port: 3001, url: nil, env: nil, stopCommand: nil),
        // Grafana + OTel (otel-lgtm) en podman: levanta la VM si está caída y el compose del runner.
        ServiceSpec(
            id: "grafana", name: "Grafana (OTel)",
            command: "(podman machine start 2>/dev/null || true) && podman compose -f apps/runner-v2/otel/compose.yaml up -d",
            cwd: root, port: 3000, url: "http://localhost:3000", env: nil,
            stopCommand: "podman stop ia-flow-otel-lgtm"),
        // El proxy OTLP con token (:4319 → otel-lgtm :4318) ya vive como LaunchAgent: se maneja con launchctl.
        ServiceSpec(
            id: "otlp-proxy", name: "OTLP proxy",
            command: "launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/link.julianjab.otlp-proxy.plist",
            cwd: home, port: 4319, url: nil, env: nil,
            stopCommand: "launchctl bootout gui/$(id -u)/link.julianjab.otlp-proxy"),
    ]
}

/// Lee `services.json`; si no existe lo crea con los defaults para que se pueda editar.
func loadServices() -> [ServiceSpec] {
    let root = (Bundle.main.object(forInfoDictionaryKey: "IAFlowRoot") as? String)
        ?? FileManager.default.currentDirectoryPath
    let path = "\(configDir)/services.json"
    if let data = FileManager.default.contents(atPath: path),
       var specs = try? JSONDecoder().decode([ServiceSpec].self, from: data) {
        // Un services.json viejo no conoce los servicios nuevos: se agregan al final.
        let known = Set(specs.map(\.id))
        let missing = defaultServices(root: root).filter { !known.contains($0.id) }
        if !missing.isEmpty { specs += missing; save(specs, to: path) }
        return specs
    }
    let specs = defaultServices(root: root)
    save(specs, to: path)
    return specs
}

func save(_ specs: [ServiceSpec], to path: String) {
    try? FileManager.default.createDirectory(atPath: configDir, withIntermediateDirectories: true)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    if let data = try? encoder.encode(specs) { FileManager.default.createFile(atPath: path, contents: data) }
}

/// ¿Hay algo escuchando en localhost:port? (connect no bloqueante sobre loopback: instantáneo)
func portIsOpen(_ port: Int) -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(port).bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let result = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    return result == 0
}

final class Service {
    enum State { case stopped, running, stopping, starting }

    let spec: ServiceSpec
    private(set) var state: State = .stopped
    private var process: Process?
    private var restartAfterStop = false
    var onChange: (() -> Void)?

    init(spec: ServiceSpec) { self.spec = spec }

    var isDetached: Bool { spec.stopCommand != nil }

    var logPath: String { "\(logDir)/\(spec.id).log" }

    /// Escucha en el puerto pero no lo levantamos nosotros (otra terminal, otro proceso).
    var isExternal: Bool {
        guard state == .stopped, let port = spec.port else { return false }
        return portIsOpen(port)
    }

    /// Servicios detached: el estado es lo que diga el puerto (salvo mientras corre un comando).
    func syncFromPort() {
        guard isDetached, state != .starting, state != .stopping, let port = spec.port else { return }
        state = portIsOpen(port) ? .running : .stopped
    }

    /// Corre `command` hasta que termine, y sondea el puerto hasta que llegue al estado esperado.
    private func runDetached(_ command: String, becoming target: State, restartAfter: Bool = false) {
        state = target == .running ? .starting : .stopping
        onChange?()
        try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: logPath, contents: nil)
        let log = FileHandle(forWritingAtPath: logPath)
        let p = shellProcess(command, log: log)
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.pollPort(until: target, attemptsLeft: 90, restartAfter: restartAfter) }
        }
        do { try p.run() } catch {
            log?.write(Data("no arrancó: \(error)\n".utf8))
            state = .stopped
            onChange?()
        }
    }

    private func pollPort(until target: State, attemptsLeft: Int, restartAfter: Bool) {
        let isUp = spec.port.map(portIsOpen) ?? (target == .running)
        if isUp == (target == .running) || attemptsLeft == 0 {
            state = isUp ? .running : .stopped
            onChange?()
            if restartAfter { runDetached(spec.command, becoming: .running) }
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            self?.pollPort(until: target, attemptsLeft: attemptsLeft - 1, restartAfter: restartAfter)
        }
    }

    /// `zsh -lc` con el PATH del usuario; `setsid` para que `kill(-pid)` baje a todo el grupo.
    private func shellProcess(_ command: String, log: FileHandle?) -> Process {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/perl")
        p.arguments = ["-e", "use POSIX; setsid(); exec @ARGV", "/bin/zsh", "-lc", command]
        p.currentDirectoryURL = URL(fileURLWithPath: spec.cwd)
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "\(home)/.bun/bin:/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
        spec.env?.forEach { env[$0.key] = $0.value }
        p.environment = env
        p.standardOutput = log
        p.standardError = log
        p.standardInput = FileHandle.nullDevice
        return p
    }

    func start() {
        guard state == .stopped else { return }
        if isDetached { return runDetached(spec.command, becoming: .running) }
        try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: logPath, contents: nil)
        let log = FileHandle(forWritingAtPath: logPath)

        let p = shellProcess("exec \(spec.command)", log: log)
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.didExit() }
        }
        do {
            try p.run()
            process = p
            state = .running
        } catch {
            log?.write(Data("no arrancó: \(error)\n".utf8))
        }
        onChange?()
    }

    func stop() {
        if let stopCommand = spec.stopCommand {
            if state == .running { runDetached(stopCommand, becoming: .stopped) }
            return
        }
        guard state == .running, let p = process else { return }
        state = .stopping
        kill(-p.processIdentifier, SIGTERM)
        // Si no cae en 5 s, SIGKILL al grupo.
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self, self.state == .stopping, let p = self.process else { return }
            kill(-p.processIdentifier, SIGKILL)
        }
        onChange?()
    }

    func restart() {
        if isDetached, state == .running, let stopCommand = spec.stopCommand {
            return runDetached(stopCommand, becoming: .stopped, restartAfter: true)
        }
        switch state {
        case .stopped: start()
        case .running: restartAfterStop = true; stop()
        case .stopping: restartAfterStop = true
        case .starting: break
        }
    }

    private func didExit() {
        process = nil
        state = .stopped
        if restartAfterStop {
            restartAfterStop = false
            start()
        } else {
            onChange?()
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let services = loadServices().map(Service.init)
    private let menu = NSMenu()

    func applicationDidFinishLaunching(_ notification: Notification) {
        menu.delegate = self
        statusItem.menu = menu
        services.forEach { $0.onChange = { [weak self] in self?.refreshIcon() } }
        services.forEach { $0.syncFromPort() }
        refreshIcon()
    }

    func applicationWillTerminate(_ notification: Notification) {
        services.filter { !$0.isDetached }.forEach { $0.stop() }
        // Dar un respiro a los SIGTERM antes de salir.
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
    }

    private func refreshIcon() {
        let anyRunning = services.contains { $0.state != .stopped }
        let symbol = anyRunning ? "bolt.circle.fill" : "bolt.circle"
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "ia-flow")
        image?.isTemplate = true
        statusItem.button?.image = image
    }

    // El menú se reconstruye al abrirlo: así el estado (y el sondeo de puertos) está fresco.
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        services.forEach { $0.syncFromPort() }
        refreshIcon()
        for service in services { menu.addItem(item(for: service)) }
        menu.addItem(.separator())
        menu.addItem(action("Iniciar todo", #selector(startAll)))
        menu.addItem(action("Reiniciar todo", #selector(restartAll)))
        menu.addItem(action("Detener todo", #selector(stopAll)))
        menu.addItem(.separator())
        menu.addItem(action("Editar servicios…", #selector(editConfig)))
        menu.addItem(action("Salir (detiene los procesos que levantó)", #selector(quit), key: "q"))
    }

    private func item(for service: Service) -> NSMenuItem {
        let external = service.isExternal
        let (dot, color): (String, NSColor) = switch service.state {
        case .running: ("●", .systemGreen)
        case .stopping, .starting: ("●", .systemOrange)
        case .stopped: external ? ("●", .systemYellow) : ("○", .secondaryLabelColor)
        }
        var title = "\(dot)  \(service.spec.name)"
        if let port = service.spec.port { title += "  :\(port)" }
        if external { title += "  (externo)" }
        let parent = NSMenuItem()
        parent.attributedTitle = NSMutableAttributedString(string: title).then {
            $0.addAttribute(.foregroundColor, value: color, range: NSRange(location: 0, length: 1))
        }
        let sub = NSMenu()
        let running = service.state == .running
        sub.addItem(action("Iniciar", #selector(serviceAction(_:)), service: service, verb: "start", enabled: service.state == .stopped && !external))
        sub.addItem(action("Reiniciar", #selector(serviceAction(_:)), service: service, verb: "restart", enabled: service.state == .running))
        sub.addItem(action("Detener", #selector(serviceAction(_:)), service: service, verb: "stop", enabled: running))
        sub.addItem(.separator())
        if service.spec.url != nil {
            sub.addItem(action("Abrir en el navegador", #selector(serviceAction(_:)), service: service, verb: "open"))
        }
        sub.addItem(action("Ver log", #selector(serviceAction(_:)), service: service, verb: "log"))
        parent.submenu = sub
        return parent
    }

    private func action(_ title: String, _ selector: Selector, key: String = "", service: Service? = nil, verb: String? = nil, enabled: Bool = true) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        item.target = self
        item.isEnabled = enabled
        if let service, let verb { item.representedObject = [service, verb] as [Any] }
        return item
    }

    @objc private func serviceAction(_ sender: NSMenuItem) {
        guard let pair = sender.representedObject as? [Any],
              let service = pair[0] as? Service, let verb = pair[1] as? String else { return }
        switch verb {
        case "start": service.start()
        case "stop": service.stop()
        case "restart": service.restart()
        case "open": if let url = service.spec.url.flatMap(URL.init(string:)) { NSWorkspace.shared.open(url) }
        case "log": openLogInITerm(service)
        default: break
        }
    }

    /// Abre `tail -f` del log en una ventana nueva de iTerm; sin iTerm, el log en el editor por defecto.
    private func openLogInITerm(_ service: Service) {
        guard NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.googlecode.iterm2") != nil else {
            NSWorkspace.shared.open(URL(fileURLWithPath: service.logPath))
            return
        }
        if !FileManager.default.fileExists(atPath: service.logPath) {
            FileManager.default.createFile(atPath: service.logPath, contents: nil)
        }
        let command = "tail -n 200 -f '\(service.logPath)'"
        let script = """
        tell application "iTerm"
            activate
            create window with default profile command "\(command)"
        end tell
        """
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", script]
        try? p.run()
    }

    @objc private func startAll() { services.forEach { if !$0.isExternal { $0.start() } } }
    @objc private func restartAll() { services.forEach { $0.restart() } }
    @objc private func stopAll() { services.forEach { $0.stop() } }
    @objc private func editConfig() { NSWorkspace.shared.open(URL(fileURLWithPath: "\(configDir)/services.json")) }
    @objc private func quit() { NSApp.terminate(nil) }
}

extension NSMutableAttributedString {
    func then(_ body: (NSMutableAttributedString) -> Void) -> NSMutableAttributedString { body(self); return self }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
