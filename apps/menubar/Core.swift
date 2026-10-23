import AppKit
import Darwin

// Lo que no es interfaz: la config de servicios y el sondeo de puertos. Sin estado propio; lo usan Service.swift,
// Model.swift y main.swift. Los túneles de julianjab.link ya no son del menú: pasaron a MacPulse.

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
    /// Los servicios de un mismo grupo van juntos, separados de los demás en el menú.
    var group: String?
    /// Regex (pgrep -f) con la que se reconoce el proceso del servicio aunque lo haya lanzado otra
    /// instancia de la app (uno que no abre puerto local: sin esto un huérfano se vería detenido).
    var processPattern: String?
}

// IA_FLOW_MENUBAR_HOME aísla la config y los logs en otra carpeta (pruebas); no cambia el HOME real.
let home = ProcessInfo.processInfo.environment["IA_FLOW_MENUBAR_HOME"] ?? FileManager.default.homeDirectoryForCurrentUser.path
let configDir = "\(home)/.config/ia-flow-menubar"
let logDir = "\(home)/.local/state/ia-flow/menubar"

func defaultServices(root: String) -> [ServiceSpec] {
    [
        // IA_FLOW_ALLOWED_HOSTS: sin él vite sólo acepta localhost y un túnel de julianjab.link da 403.
        ServiceSpec(id: "web", name: "Web", command: "bun run --cwd apps/web vite build && bun run --cwd apps/web preview", cwd: root, port: 5173, url: "http://localhost:5173",
            env: ["IA_FLOW_ALLOWED_HOSTS": ".julianjab.link"], stopCommand: nil),
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
            command: "launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/link.julianjab.otlp-proxy.plist 2>/dev/null; launchctl kickstart -k gui/$(id -u)/link.julianjab.otlp-proxy",
            cwd: home, port: 4319, url: nil, env: nil,
            stopCommand: "launchctl bootout gui/$(id -u)/link.julianjab.otlp-proxy"),
    ]
}

/// Lee `services.json`; si no existe lo crea con los defaults para que se pueda editar.
func loadServices() -> [ServiceSpec] {
    let root = (Bundle.main.object(forInfoDictionaryKey: "IAFlowRoot") as? String)
        ?? FileManager.default.currentDirectoryPath
    let path = "\(configDir)/services.json"
    // El archivo existe pero no se puede leer (una coma de más, un tipo equivocado): NO se pisa con los defaults,
    // que es lo que borraría los servicios propios. Se usan en memoria y el error queda en el log de la app.
    if let data = FileManager.default.contents(atPath: path), (try? JSONDecoder().decode([ServiceSpec].self, from: data)) == nil {
        FileHandle.standardError.write(Data("[menubar] \(path) no es un JSON válido: uso los servicios por defecto sin guardarlos\n".utf8))
        return defaultServices(root: root)
    }
    if let data = FileManager.default.contents(atPath: path),
       var specs = try? JSONDecoder().decode([ServiceSpec].self, from: data) {
        // Los defaults que aparecieron después de crear el archivo se agregan una sola vez: los ids
        // ya conocidos van a `known-ids.json`, así borrar un servicio a propósito no lo resucita.
        let knownPath = "\(configDir)/known-ids.json"
        let known = Set((FileManager.default.contents(atPath: knownPath)
            .flatMap { try? JSONDecoder().decode([String].self, from: $0) }) ?? specs.map(\.id))
        let defaults = defaultServices(root: root)
        let missing = defaults.filter { !known.contains($0.id) }
        if !missing.isEmpty { specs += missing; save(specs, to: path) }
        let allKnown = known.union(defaults.map(\.id)).sorted()
        if let data = try? JSONEncoder().encode(allKnown) { FileManager.default.createFile(atPath: knownPath, contents: data) }
        return specs
    }
    let specs = defaultServices(root: root)
    save(specs, to: path)
    let ids = specs.map(\.id).sorted()
    if let data = try? JSONEncoder().encode(ids) { FileManager.default.createFile(atPath: "\(configDir)/known-ids.json", contents: data) }
    return specs
}

/// Los servicios del menú (`services.json`). Lo usan la interfaz y `--status`, para que no puedan divergir.
func loadAllSpecs() -> [ServiceSpec] { loadServices() }

func save(_ specs: [ServiceSpec], to path: String) {
    try? FileManager.default.createDirectory(atPath: configDir, withIntermediateDirectories: true)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    if let data = try? encoder.encode(specs) { FileManager.default.createFile(atPath: path, contents: data) }
}

/// ¿Hay algo escuchando en localhost:port? Prueba IPv4 y IPv6: vite y otros escuchan sólo en `::1`.
func portIsOpen(_ port: Int) -> Bool {
    func connects(family: Int32, address: UnsafeRawPointer, size: Int) -> Bool {
        let fd = socket(family, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        return connect(fd, address.assumingMemoryBound(to: sockaddr.self), socklen_t(size)) == 0
    }
    var v4 = sockaddr_in()
    v4.sin_family = sa_family_t(AF_INET)
    v4.sin_port = in_port_t(port).bigEndian
    v4.sin_addr.s_addr = inet_addr("127.0.0.1")
    if connects(family: AF_INET, address: &v4, size: MemoryLayout<sockaddr_in>.size) { return true }
    var v6 = sockaddr_in6()
    v6.sin6_family = sa_family_t(AF_INET6)
    v6.sin6_port = in_port_t(port).bigEndian
    v6.sin6_addr = in6addr_loopback
    return connects(family: AF_INET6, address: &v6, size: MemoryLayout<sockaddr_in6>.size)
}

/// Escapa los metacaracteres de una regex extendida (pgrep -f) para buscar un texto literal.
func escapedForERE(_ text: String) -> String {
    var out = ""
    for ch in text {
        if "\\.[]{}()*+?|^$".contains(ch) { out.append("\\") }
        out.append(ch)
    }
    return out
}
