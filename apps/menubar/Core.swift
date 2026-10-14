import AppKit
import Darwin

// Lo que no es interfaz: la config de servicios y túneles, sondeos de puertos y las llamadas a cloudflared y a la
// API de Cloudflare. Sin estado propio; lo usan Service.swift, Model.swift y main.swift.

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
    /// Si lo trae, el servicio se puede borrar del menú: corre esto (ej. borrar el túnel) y se olvida.
    var deleteCommand: String?
    /// Regex (pgrep -f) con la que se reconoce el proceso del servicio aunque lo haya lanzado otra
    /// instancia de la app (un túnel no abre puerto local: sin esto un huérfano se vería detenido).
    var processPattern: String?
}

// IA_FLOW_MENUBAR_HOME aísla la config, los logs y los túneles en otra carpeta (pruebas); no cambia el HOME real.
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

let tunnelsPath = "\(configDir)/tunnels.json"

/// Los túneles creados desde el menú (los que ya no se ven en `services.json`).
func loadTunnels() -> [ServiceSpec] {
    let saved = FileManager.default.contents(atPath: tunnelsPath)
        .flatMap { try? JSONDecoder().decode([ServiceSpec].self, from: $0) } ?? []
    // Los túneles guardados antes de `processPattern` lo derivan de su id (`tunnel-<sub>`).
    return saved.map { spec in
        var spec = spec
        if spec.processPattern == nil { spec.processPattern = tunnelProcessPattern(name: "menubar-\(spec.id.dropFirst("tunnel-".count))") }
        return spec
    }
}

func tunnelProcessPattern(name: String) -> String {
    "cloudflared tunnel --config .* run --url http://localhost:[0-9]+ \(name)$"
}

/// Un túnel con nombre de cloudflared a `puerto`, bajo `<sub>.julianjab.link`. Idempotente: al
/// iniciar crea el túnel y el DNS si faltan (`tunnel info` sale 0 aunque no exista: se usa `list`).
/// Sin `-f`: un registro ajeno no se pisa. Pisarlo (confirmado por la persona) es sólo del primer
/// inicio, con `Service.nextStartEnv`, para que no quede grabado en `tunnels.json`. `--config` propio (también en `route dns`) ignora el `tunnel:` del `config.yml` global de ~/.cloudflared,
/// que si no hace que el CNAME apunte al túnel viejo en vez de al nuevo.
func tunnelSpec(sub: String, port: Int) -> ServiceSpec {
    let name = "menubar-\(sub)"
    let host = "\(sub).julianjab.link"
    let config = "\(configDir)/tunnel.yml"
    return ServiceSpec(
        id: "tunnel-\(sub)", name: "\(host) → :\(port)",
        command: "echo 'no-autoupdate: true' > '\(config)'; "
            + "cloudflared tunnel list -n \(name) -o json 2>/dev/null | grep -q '\"name\"' || cloudflared tunnel create \(name) || exit 1; "
            + "cloudflared tunnel --config '\(config)' route dns \(name) \(host) 2>&1 | tail -1; "
            + "exec cloudflared tunnel --config '\(config)' run --url http://localhost:\(port) \(name)",
        cwd: home, port: nil, url: "https://\(host)", env: nil, stopCommand: nil,
        group: "Túneles",
        deleteCommand: "cloudflared tunnel cleanup \(name); cloudflared tunnel delete \(name)",
        processPattern: tunnelProcessPattern(name: name))
}

/// Puertos TCP en escucha en esta máquina (`lsof -Fcn`: líneas `c<comando>` y `n<dirección>:<puerto>`),
/// sin repetir y de menor a mayor. Es lo que se ofrece al elegir qué exponer.
func listeningPorts() -> [(port: Int, command: String)] {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
    p.arguments = ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fcn"]
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    guard (try? p.run()) != nil else { return [] }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    var command = ""
    var found: [Int: String] = [:]
    for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
        switch line.first {
        case "c": command = String(line.dropFirst())
        case "n":
            if let port = line.split(separator: ":").last.flatMap({ Int($0) }), found[port] == nil { found[port] = command }
        default: break
        }
    }
    return found.sorted { $0.key < $1.key }.map { (port: $0.key, command: $0.value) }
}

/// Zona y token de la API de Cloudflare (archivos propios de la app, el token con permisos 0600).
func cloudflareAuth() -> (zone: String, token: String)? {
    func read(_ name: String) -> String? {
        (try? String(contentsOfFile: "\(configDir)/\(name)", encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    guard let zone = read("cloudflare-zone-id"), let token = read("cloudflare-token"),
          !zone.isEmpty, !token.isEmpty else { return nil }
    return (zone, token)
}

/// Llamada síncrona a la API de Cloudflare; el JSON de la respuesta o nil si falla.
func cloudflareRequest(_ method: String, _ path: String, token: String) -> [String: Any]? {
    guard let url = URL(string: "https://api.cloudflare.com/client/v4\(path)") else { return nil }
    var request = URLRequest(url: url, timeoutInterval: 10)
    request.httpMethod = method
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    var result: [String: Any]?
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { data, _, _ in
        result = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + 12)
    return result
}

/// El id del túnel de cloudflared con ese nombre (`tunnel list -n … -o json`).
func cloudflaredTunnelID(_ name: String) -> String? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["-lc", "cloudflared tunnel list -n \(name) -o json 2>/dev/null"]
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
    p.environment = env
    guard (try? p.run()) != nil else { return nil }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    return (try? JSONSerialization.jsonObject(with: data) as? [[String: Any]])?.first?["id"] as? String
}

/// Borra el CNAME de `<sub>.julianjab.link` SÓLO si apunta al túnel `menubar-<sub>`
/// (`<id>.cfargotunnel.com`): un registro de otro túnel o servicio no se toca. Devuelve qué pasó.
func removeTunnelDNS(sub: String) -> String {
    guard let auth = cloudflareAuth() else {
        return "[menubar] sin token de Cloudflare: el registro DNS de \(sub).julianjab.link queda"
    }
    guard let id = cloudflaredTunnelID("menubar-\(sub)") else {
        return "[menubar] no encontré el túnel menubar-\(sub): no sé qué registro borrar"
    }
    let host = "\(sub).julianjab.link"
    let query = "/zones/\(auth.zone)/dns_records?type=CNAME&name=\(host)"
    guard let listed = cloudflareRequest("GET", query, token: auth.token),
          listed["success"] as? Bool == true, let records = listed["result"] as? [[String: Any]] else {
        return "[menubar] no pude consultar el DNS de \(host) (¿token sin permiso DNS:Edit en la zona?)"
    }
    let own = records.filter { ($0["content"] as? String) == "\(id).cfargotunnel.com" }
    guard !own.isEmpty else { return "[menubar] \(host) no tiene un registro de este túnel: no borré nada" }
    var deleted = 0
    for record in own {
        guard let recordID = record["id"] as? String,
              let response = cloudflareRequest("DELETE", "/zones/\(auth.zone)/dns_records/\(recordID)", token: auth.token),
              response["success"] as? Bool == true else { continue }
        deleted += 1
    }
    return "[menubar] DNS de \(host) borrado (\(deleted)/\(own.count))"
}

func appendLog(_ message: String, to path: String) {
    guard let handle = FileHandle(forWritingAtPath: path) else { return }
    handle.seekToEndOfFile()
    handle.write(Data("\n\(message)\n".utf8))
    try? handle.close()
}

/// El subdominio de un túnel creado desde el menú (su id es `tunnel-<sub>`).
func tunnelSub(_ service: Service) -> String { String(service.spec.id.dropFirst("tunnel-".count)) }

/// ¿Ese hostname ya resuelve? (Cloudflare aplana el CNAME: se mira cualquier registro.)
func dnsRecordExists(_ host: String) -> Bool {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/dig")
    p.arguments = ["+short", "+time=3", "+tries=1", host]
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    guard (try? p.run()) != nil else { return false }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    // Un timeout hace que dig imprima `;; …` y salga distinto de 0: eso no es un registro.
    guard p.terminationStatus == 0 else { return false }
    return String(decoding: data, as: UTF8.self).split(separator: "\n").contains { !$0.hasPrefix(";;") && !$0.isEmpty }
}

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

/// ¿Algún túnel de ~/.cloudflared (los de siempre) ya sirve ese hostname?
func hostnameInUse(_ host: String) -> Bool {
    let dir = "\(home)/.cloudflared"
    let files = (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
    return files.filter { $0.hasSuffix(".yml") }.contains {
        (try? String(contentsOfFile: "\(dir)/\($0)", encoding: .utf8))?.contains("hostname: \(host)") == true
    }
}
